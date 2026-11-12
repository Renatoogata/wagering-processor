# Arquitetura: Distributed Wagering Processor

Este documento explica **as decisões, os trade-offs e as limitações**. Setup e comandos estão no [`README.md`](README.md).

Princípio que guia tudo: **o banco é o último guardião.** O código aplica as regras; o PostgreSQL garante que, mesmo com um bug ou várias instâncias concorrendo, nenhuma invariante financeira é violada (saldo negativo, débito duplicado, ledger alterado, evento perdido).

---

## 1. Visão geral

```
  HTTP (provedor) ──┐                                         ┌──► wagering-events.fifo
                    ├──► ProcessWagerTransaction ──► PostgreSQL ─┤        (relay da outbox)
  SQS wager-tx ─────┘    (MESMO use case)          1 transação  │
       │                                          SQL por      └──► worker de PENDING_REFERENCE
       └─► DLQ (permanente / limite de tentativas) operação
```

Camadas (hexagonal, dependências apontando para dentro):

| Pasta | Conteúdo | Depende de |
|---|---|---|
| `src/domain` | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, eventos, `InboxMessage`, `OutboxMessage` | nada (sem Nest, sem ORM) |
| `src/application` | casos de uso e **portas** (`UnitOfWork`, repositórios, `EventPublisher`, `Clock`, `Metrics`) | domínio |
| `src/infrastructure` | MikroORM (entidades de persistência, mappers, migrations), SQS, medidores | aplicação + domínio |
| `src/interfaces` | controllers HTTP, consumer SQS, workers, telemetria comum | aplicação |
| `src/app.module.ts` | composição: o único lugar que liga portas a adaptadores | tudo |

Os casos de uso são classes TypeScript puras, registradas por factory no Nest. Isso permite testá-los contra o Postgres real sem subir o framework.

---

## 2. ORM, mapeamento do `Money` e estratégia transacional

### Por que MikroORM

- Tem **Unit of Work** e **identity map** nativos, que casam com "uma transação SQL por operação".
- Tem `EntitySchema`, que permite mapear sem decorators. Assim o domínio fica livre do ORM.
- Tem `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`) e `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) de primeira classe.
- As migrations são classes TS com SQL explícito. O schema é parte do que está sendo avaliado, então ele é escrito à mão, não gerado.

**O domínio não é mapeado diretamente.** As classes de domínio têm construtor privado e invariantes; o ORM quer instanciar objetos e escrever campos livremente. Por isso existem **entidades de persistência** (o formato da linha) e **mappers** que só traduzem formato: `toState()` → linha, e linha → `rehydrate()`. O custo é escrever os mappers; o ganho é um domínio sem nenhuma dependência de infraestrutura.

### Money

| Onde | Representação | Por quê |
|---|---|---|
| Domínio | `bigint` em centavos + moeda ISO-4217 | aritmética inteira e exata; `number` nunca entra |
| JSON (API, SQS, eventos) | `{ "amount": "25.00", "currency": "BRL" }`, sempre string com 2 casas | uma única forma de escrita por valor (base do hash de idempotência) |
| Banco | `NUMERIC(20,2)` | exato; somas do ledger feitas em `NUMERIC` no próprio Postgres |

- O mapper converte `NUMERIC` (lido como string) ↔ `Money.from({ amount, currency })`. Nunca passa por `number`.
- `Money` **recusa** em vez de arredondar: `25.005`, `25.0`, `25` e `-1` são inválidos. Arredondar em silêncio mudaria o valor do provedor. Aceitar `25.0` daria dois hashes para a mesma operação.
- Escolhi `bigint` em centavos e não `decimal.js`: com escala fixa de 2 casas, o inteiro resolve sem dependência externa.

### Estratégia transacional

**Uma operação = uma transação SQL**, aberta pela `UnitOfWork` (`em.fork().transactional`), com isolamento **READ COMMITTED**:

```
BEGIN
  SELECT ... FROM wallets WHERE id = $1 FOR UPDATE      -- 1. lock da wallet (fila por wallet)
  inbox: esta mensagem já foi processada?               -- 2a. (só SQS) redelivery → resultado original
  idempotência: esta key já existe?                     -- 2b. replay (mesmo hash) ou 409 (hash diferente)
  decide: aplica, rejeita ou deixa pendente             -- 3. regras de negócio no domínio
  INSERT transação · UPDATE wallet · INSERT ledger      -- 4. tudo junto
  INSERT outbox (eventos) · INSERT inbox
COMMIT                                                   -- 5. só então a resposta / o ack
```

READ COMMITTED basta. A disputa pelo saldo é resolvida pelo lock da linha, e todas as unicidades (key, reversão única, versão do ledger, inbox) são constraints.

---

## 3. Concorrência

**Unidade de concorrência: a `walletId`.** Escolhi **lock pessimista por linha** (`SELECT ... FOR UPDATE` na wallet):

- Duas operações na mesma wallet fazem fila no Postgres. A segunda lê o saldo já atualizado, sem lost update e sem `read → calculate → update` desprotegido.
- Wallets diferentes não se bloqueiam: o lock é por linha, nunca global.
- Funciona igual com N instâncias, porque o lock está no banco, o único ponto que todas compartilham.

**Por que não lock otimista?** Numa *hot wallet* (muitas apostas simultâneas no mesmo jogador), o otimista vira uma tempestade de retries: N-1 de N tentativas falham a cada rodada. Com o pessimista, cada operação acerta de primeira, e a espera é curta, porque a transação dura milissegundos. A métrica `wallet_lock_wait_seconds` mede essa espera.

**Por que a idempotência é checada DEPOIS do lock?** Se fosse antes, duas cópias simultâneas da mesma BET leriam "não existe" ao mesmo tempo e as duas debitariam. Depois do lock, a segunda só roda quando a primeira já commitou e **enxerga** a transação gravada, virando replay. Quando as cópias apontam wallets diferentes (payload adulterado), não há lock em comum: o `UNIQUE (idempotency_key)` barra a segunda, a transação é desfeita e a nova tentativa cai no caminho de conflito.

**Conflitos residuais.** Colisão em constraint única ou deadlock viram `ConcurrentWriteConflictError` e são repetidos até 3 vezes; na repetição, a operação vê o que a outra gravou. Se ainda assim falhar, a resposta é 503 (retryable).

**Ordem de locks fixa:** wallet → transação, em todos os caminhos (inclusive no worker de pendentes), para evitar deadlock.

**Cenário obrigatório** (100.00, duas BETs de 80.00 em paralelo): uma PROCESSED, uma REJECTED `INSUFFICIENT_FUNDS`, saldo 20.00, um único débito. Testado em `test/integration/process-wager-transaction.test.ts` e, com 3 processos reais, em `test/concurrency/multi-instance.test.ts`.

**SQS FIFO é otimização, não garantia.** `MessageGroupId = walletId` reduz a disputa e preserva a ordem por wallet, mas a correção vem do banco: lock, constraints e inbox. A deduplicação da FIFO só vale por 5 minutos.

---

## 4. Garantias no schema

Migrations em `src/infrastructure/persistence/migrations/`. O que o banco garante, mesmo que a aplicação erre:

| Garantia | Como |
|---|---|
| Dinheiro exato | `NUMERIC(20,2)` em todas as colunas de valor |
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; `balance_before/after >= 0` no ledger |
| Uma wallet por jogador e moeda | `UNIQUE (player_id, currency)` |
| Idempotência persistente | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Operação na moeda da wallet | FK composta `(wallet_id, currency) → wallets (id, currency)` |
| Referência no mesmo escopo | FK composta `(reference_transaction_id, wallet_id, provider_id, round_id)` (mesmo provider, wallet/jogador/moeda e rodada) |
| Reversão uma única vez (7.4) | índice único **parcial** `(reference_transaction_id, kind) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Ledger imutável | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` em `wallet_ledger_entries` |
| Ledger encadeado | trigger `ledger_chain`: cada lançamento continua do anterior (`balance_before` = último `balance_after`, versão +1); `UNIQUE (wallet_id, wallet_version)` |
| Saldo == ledger | **constraint trigger DEFERRED**: no COMMIT, toda mudança de saldo precisa do lançamento correspondente (só no commit, porque dentro da transação a wallet muda antes de o lançamento existir) |
| Estados terminais congelados | trigger: transação PROCESSED/REJECTED/FAILED não muda mais; campos de negócio são imutáveis |
| Coerência de estado | `CHECK`s: `failure_code` existe se e só se REJECTED/FAILED; PROCESSED tem `processed_at` e saldo observado; reversão processada tem a referência resolvida; REFUND/ROLLBACK exigem referência |
| Inbox | PK `(consumer_name, message_id)` |
| Varredura eficiente | índices parciais `WHERE published_at IS NULL` (outbox) e `WHERE status = 'PENDING_REFERENCE'` |

---

## 5. Idempotência

- **Chave:** `Idempotency-Key` (header HTTP, obrigatório) ou `data.idempotencyKey` (SQS). É única no banco.
- **Hash do payload:** SHA-256 do **JSON canônico** (chaves ordenadas, sem espaços, números recusados porque dinheiro é string) dos **campos de negócio**: provider, ids, wallet, player, rodada, jogo, kind, money e referência. Ficam de fora os metadados de transporte (key, `messageId`, headers, correlationId). Consequência: a mesma operação por HTTP e por SQS tem o mesmo hash, e a segunda é replay.
- **Replay** (mesma key, mesmo hash): devolve o **resultado original**, com o mesmo status HTTP e o saldo observado **naquele momento** (regra 7.7). Nada é reprocessado.
- **Conflito** (mesma key, hash diferente): 409 `IDEMPOTENCY_CONFLICT`. Nada é gravado.
- **Mesmo `(providerId, externalTransactionId)` com outra key:** 409 `DUPLICATE_EXTERNAL_TRANSACTION`. Não é replay (a key manda) nem pode ser uma segunda operação (o UNIQUE impede).
- **Nunca em memória:** toda verificação consulta o banco.

---

## 6. Regras de negócio e interpretações adotadas

As regras da seção 7 são implementadas no domínio (`WagerTransaction.checkReference`, `ledgerDirectionFor`, `Wallet.credit/debit`) e reforçadas no schema.

**Interpretações** (o que o enunciado deixa em aberto):

1. **WIN com referência:** é aceita e **informativa**. Fica gravada para auditoria, mas não é resolvida nem bloqueia o crédito: o prêmio não depende da BET para ser pago. BET e LOSS não podem ter referência (400 `REFERENCE_NOT_ALLOWED`).
2. **LOSS** aceita valor `0.00`, é gravada como PROCESSED e não gera ledger nem `WalletBalanceChanged`.
3. **ROLLBACK** vai na direção **inversa** da referência: o de BET credita, o de WIN ou REFUND debita.
4. **Moeda diferente da wallet** não pode ser gravada como REJECTED, porque a FK `(wallet_id, currency)` impede: responde 422 `CURRENCY_MISMATCH` sem gravar. **Jogador diferente do dono da wallet** é gravado como REJECTED `WALLET_PLAYER_MISMATCH`.
5. **Reversão que negativaria o saldo** (regra 7.9): REJECTED `REVERSAL_WOULD_OVERDRAW`, um código diferente de `INSUFFICIENT_FUNDS`, auditável. Na prática é o ROLLBACK de um WIN cujo valor já foi apostado.
6. **Saldo inicial** na criação da wallet gera uma transação interna `OPENING` (provider reservado) e um `CREDIT` no ledger, no mesmo commit. Assim **todo** centavo do saldo tem origem no ledger.
7. **Referência resolvida mas ainda não terminal** (ex.: ROLLBACK de um REFUND que está pendente): a reversão também espera (PENDING_REFERENCE).

### Referências fora de ordem (7.1)

- REFUND/ROLLBACK cuja referência ainda não existe → `PENDING_REFERENCE`, HTTP **202**, evento `WagerTransactionPendingReference`.
- Um **worker** (`ResolveDuePendingReferences`, em todas as instâncias) busca as pendentes vencidas e reaplica **a mesma regra** do caminho principal (`decideReversal`), com a wallet travada.
- **Backoff exponencial** de 1s, 2s, 4s... limitado a 5 min por espera, com **12 tentativas** (cerca de 25 min de janela). Entrega fora de ordem em fila se resolve em segundos; 25 min cobrem também um provedor ou uma fila parados por alguns minutos, sem deixar o jogador esperando horas. É configurável (`ReferenceRetryPolicy`).
- Esgotado o limite: REJECTED `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
- Várias instâncias podem pegar a mesma pendente: o lock da wallet as enfileira, e a segunda relê, vê que já foi resolvida e pula.

---

## 7. Taxonomia de `failureCode`

Códigos estáveis (nunca renomeados). Cada um diz ao provedor **o que fazer**.

| failureCode | Quando | Provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | desistir |
| `REVERSAL_WOULD_OVERDRAW` | REFUND/ROLLBACK que negativaria o saldo (7.9) | desistir; requer análise operacional |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite (7.1) | desistir, ou enviar a referência e depois uma nova reversão |
| `REFERENCE_SCOPE_MISMATCH` | referência de outro provider, wallet, jogador, moeda ou rodada (7.2) | corrigir |
| `INVALID_REFERENCE_KIND` | REFUND de algo que não é BET; ROLLBACK de algo que não é BET/WIN/REFUND (7.3) | corrigir |
| `REFERENCE_NOT_PROCESSED` | a referência existe, mas foi REJECTED/FAILED | desistir |
| `REFERENCE_ALREADY_REVERSED` | a referência já foi revertida por esse tipo (7.4) | desistir |
| `REVERSAL_AMOUNT_MISMATCH` | valor diferente do da referência (7.5) | corrigir |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir |
| `WALLET_PLAYER_MISMATCH` | o jogador não é o dono da wallet | corrigir |
| `PROCESSING_FAILED` | erro permanente de infraestrutura (FAILED, auditável) | aguardar / suporte |

Erros de **payload** (nada gravado, HTTP 400) usam códigos próprios: `INVALID_FIELD`, `INVALID_AMOUNT`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_MESSAGE` etc.

---

## 8. API HTTP e mapeamento de status

Um **filtro único** (`ApplicationExceptionFilter`) traduz erro em status. Os controllers não têm try/catch, então o mapeamento é idêntico em todos os endpoints. A pergunta que o status responde é: *"o que o provedor faz agora?"*

| Status | Situação | O provedor deve |
|---|---|---|
| 200 | PROCESSED (inclusive replay) | seguir |
| 201 | wallet criada | seguir |
| 202 | PENDING_REFERENCE | aguardar o evento / consultar depois |
| 400 | payload inválido | **corrigir**; reenviar igual nunca funciona |
| 404 | wallet/transação inexistente | corrigir a referência |
| 409 | key reutilizada, external id duplicado, wallet duplicada | **não** reenviar: é outra operação |
| 422 | REJECTED (com `transactionId` e `failureCode`) ou regra não gravável (moeda) | não reenviar; a decisão é final |
| 503 | falha transitória (banco fora, conflito após retries), com `Retry-After` | **reenviar com a mesma key** (seguro) |
| 500 | erro inesperado (sem vazar detalhes) | reenviar com a mesma key; alertar |

- O **replay devolve o mesmo status** do original, porque o status é calculado a partir do estado gravado.
- O **ledger** é paginado por um cursor opaco (`seq` do ledger, append-only), não por OFFSET: a paginação não repete nem pula itens se entrar um lançamento novo entre uma página e outra.
- O **correlationId** vem do header `x-correlation-id` (ou é gerado), volta na resposta e vai para os logs e para os eventos.

---

## 9. Consumer SQS

`SqsWagerConsumer` (`src/interfaces/messaging`):

- **Mesmo use case** da API, com a **inbox** `(consumerName, messageId)` gravada na **mesma transação**. O `messageId` usado é o **do envelope** (estável entre reenvios do produtor), não o `MessageId` da SQS (que muda a cada envio).
- **Ack (DeleteMessage) só depois do commit.** Se o processo morrer entre o commit e o ack, a SQS reentrega, e a inbox, consultada com a wallet travada, devolve o resultado original sem efeito novo.
- **Mesmo messageId com conteúdo diferente:** `INBOX_MESSAGE_CONFLICT` → DLQ.
- **Classificação de erros** (`classifyFailure`). A pergunta é "processar de novo pode dar certo?"

| Tipo | Exemplos | Ação |
|---|---|---|
| Negócio (terminal) | regra violada (moeda) | **ack** (REJECTED nem é erro: foi gravada e é ack) |
| Permanente | payload/JSON inválido, wallet inexistente, conflitos de idempotência/inbox | **DLQ** com o motivo (`failureReason`) |
| Transitório | banco fora, deadlock, lock timeout | **retry** com backoff exponencial (`ChangeMessageVisibility`: 2s, 4s, 8s... até 60s) |
| Desconhecido | bug | tratado como transitório: na dúvida, não descarta |
| Limite | 4ª entrega de algo transitório/desconhecido | **DLQ** `MAX_ATTEMPTS_EXCEEDED` |

- **DLQ explícita:** a mensagem é **copiada** para a DLQ (com o motivo) e só então apagada. Morrer no meio deixa uma duplicata na DLQ, inofensiva; a ordem inversa poderia perder a mensagem. O `RedrivePolicy` da fila (`maxReceiveCount = 5`) é a rede de segurança para um crash em loop.
- **Ordem:** mensagens do mesmo `MessageGroupId` (walletId) são processadas em sequência. Se uma não for confirmada, as seguintes do lote são devolvidas. Grupos diferentes rodam em paralelo.
- **SIGTERM:** corta o long polling, termina a mensagem em andamento (commit + ack) e devolve a visibilidade das que não começaram (`VisibilityTimeout = 0`), para outra instância pegar na hora.

---

## 10. Transactional Outbox

- Os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) são gravados em `outbox_messages` **na mesma transação** que muda o saldo. Não existe publicação antes do commit: a linha só existe depois dele.
- **Relay** (`PublishOutboxBatch`, rodando num `PollingWorker` em todas as instâncias), uma transação por lote:
  1. `SELECT ... FOR UPDATE SKIP LOCKED` de até 10 pendentes vencidas, em ordem de `seq`;
  2. `SendMessageBatch` para `wagering-events.fifo`;
  3. marca `published_at`, ou agenda retry com backoff (1s ... 60s, **sem limite**: o evento já é um fato confirmado);
  4. commit.
- **N publishers:** o `SKIP LOCKED` faz cada um pular as linhas travadas pelos outros. Ninguém espera e ninguém pega a mesma linha.
- **At-least-once:** se o processo morrer depois de publicar e antes do commit, as linhas voltam a ficar pendentes e outra instância republica. O consumidor deduplica pelo `eventId`. Como `MessageDeduplicationId = eventId`, a SQS FIFO ainda descarta a cópia dentro da janela de 5 min. Testado.
- **Ordem:** `MessageGroupId = aggregateId`. Entre publishers concorrentes, a ordem por agregado não é garantida. Por isso o `WalletBalanceChanged` carrega `walletVersion`, para o consumidor descartar evento com versão antiga.
- **Trade-off:** a transação fica aberta durante a chamada ao broker. A mitigação é lote pequeno e timeout de 5s no adaptador. A alternativa (lease: marcar "em publicação até T", commitar, publicar, marcar de novo) evita a transação longa, mas tem mais estados e casos de borda.

---

## 11. Múltiplas instâncias e desligamento

- **Nenhum estado relevante em memória.** O estado vive no Postgres (lock, idempotência, inbox, outbox, pendentes) e a fila é a SQS. Qualquer número de instâncias roda o mesmo código, com HTTP, consumer e workers.
- **Provado com processos reais** (`test/concurrency/multi-instance.test.ts`):
  - 3 instâncias disputando uma hot wallet por HTTP (cada requisição enviada a **duas** instâncias ao mesmo tempo) e por SQS: exatamente 10 de 40 apostas aplicadas, nenhuma duplicata, e o trabalho da fila dividido entre os processos;
  - SIGKILL numa instância com ~55 de 60 mensagens por fazer, SIGTERM em outra e uma instância nova subindo: as 60 aplicadas uma vez cada, outbox escoada, reconciliação consistente após reinício completo.
- **SIGTERM** (`enableShutdownHooks`): os workers param em ordem: **consumer** (para de receber) → **worker de pendentes** → **relay da outbox** (escoa por último). Cada um termina a rodada em andamento, que é uma transação. Roda em `beforeApplicationShutdown`, antes de o Nest fechar o banco.

---

## 12. Observabilidade

- **Logs:** uma linha JSON por evento, com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, status e duração. **Sem payload financeiro completo.** HTTP e SQS usam a mesma função (`recordWagerOutcome`).
- **Métricas:** `GET /metrics` em formato Prometheus.

| Pedido na seção 12 | Métrica |
|---|---|
| transações por status | `wager_transactions_total{channel,status}` |
| duplicatas detectadas | `wager_duplicates_total{channel}` |
| retries | `sqs_retries_total`, `pending_reference_attempts_total{status}`, `outbox_publish_failures_total` |
| DLQ | `sqs_dlq_messages_total{reason}` e o medidor `sqs_wager_dlq_messages` |
| conflitos de lock | `concurrent_write_conflicts_total{retried}`, `wallet_lock_wait_seconds` (histograma) |
| outbox lag | `outbox_oldest_pending_age_seconds` (medidor) e `outbox_lag_seconds` (histograma commit → publicação) |
| latência | `wager_processing_seconds{channel}` (histograma) |
| reconciliação | `wallet_reconciliations_total{result}` |

- Os histogramas usam **buckets fixos**: memória constante, e o Prometheus soma as instâncias e calcula p50/p95/p99.
- Os contadores são por instância (somar com `sum`). Os medidores lidos do banco ou da fila são iguais em todas (usar `max`).
- **Health:** `/health/live` (processo) e `/health/ready` (Postgres e SQS alcançáveis; 503 se não), sem autenticação.
- **Reconciliação:** `POST /wallets/:id/reconciliation` trava a wallet, soma o ledger e compara. Uma divergência é logada, contada e sinalizada (`consistent: false`), **nunca corrigida** automaticamente, porque corrigir esconderia o bug.

---

## 13. Autenticação (não implementada, por decisão)

Ponto de extensão explícito: `ProviderAuthGuard` (no-op) em todos os endpoints de negócio.

Desenho que eu adotaria:

1. Um IdP externo (Keycloak ou Zitadel) com **um client por provedor**, fluxo `client_credentials`.
2. O guard valida o JWT: assinatura via JWKS (com cache), `iss`, `aud` e `exp`.
3. **Autorização por provedor:** o claim `provider_id` precisa ser igual ao `providerId` do corpo, para que um provedor não lance operações em nome de outro. Nas consultas, o provedor só enxerga as próprias transações.
4. Health e `/metrics` ficam fora (rede interna).
5. Mensagens da SQS são canal interno confiável (IAM da fila), mas o `providerId` delas passa pelas mesmas validações de domínio.

---

## 14. Testes

`bun test` roda tudo contra **PostgreSQL e LocalStack reais** (docker compose). Nenhum teste substitui o banco ou a fila por mock.

| Pasta | O que cobre |
|---|---|
| `test/unit` | `Money` (escala, arredondamento, entradas inválidas), invariantes da `Wallet`, regras de BET/WIN/LOSS/REFUND/ROLLBACK, hash/JSON canônico, classificação de falhas, formato das métricas |
| `test/integration` | migrations e constraints; atomicidade wallet+ledger+inbox+outbox; mesma aposta **50× em paralelo**; cenário 100/80×2; wallets em paralelo; inbox e redelivery; retry e DLQ; crash depois do commit e antes do ack; SIGTERM; publishers concorrentes; crash depois de publicar; REFUND/ROLLBACK antes da referência |
| `test/e2e` | a API HTTP de verdade (Nest + Express): status, replay, cursor, reconciliação, `/metrics` |
| `test/concurrency` | **3 processos reais**, SIGKILL/SIGTERM, reinício e consistência final |

**Invariante final verificada em todos:** `wallet.balance == saldo reconstruído pelo ledger` (`expectWalletMatchesLedger`).

Os testes com tempo usam **relógio controlado** (backoff sem `sleep`). Cada suíte usa ids próprios e filas SQS próprias, e é determinística (rodada várias vezes seguidas).

---

## 15. Trade-offs e limitações

- **Lock pessimista** serializa uma hot wallet. É correto e simples, mas o throughput de **uma** wallet fica limitado à latência de uma transação. Para uma wallet com milhares de operações por segundo, seria preciso particionar ou usar saldo em "buckets".
- **O relay segura a transação durante a publicação** (seção 10). Com lote de 10 e timeout de 5s, o impacto é limitado; um *lease* escalaria melhor.
- **Os contadores das métricas ficam em memória por instância** e zeram no restart (o Prometheus lida com isso via `rate()`). Não há OpenTelemetry nem dashboard (opcionais).
- **Retries sem jitter**, para que os testes sejam determinísticos. O `SKIP LOCKED` e o lock por wallet evitam as rajadas.
- **Eventos gerados pelo worker de pendentes** usam o id da transação como `correlationId`. A transação não guarda o correlationId da chamada original; guardar custaria uma coluna.
- **Processamento mais longo que o visibility timeout** (30s) faria a mensagem reaparecer para outra instância. A inbox e o lock impedem a duplicação, mas o ideal seria um heartbeat estendendo a visibilidade.
- **Validação de moeda só de formato** (`^[A-Z]{3}$`). `XYZ` passaria. Uma lista ISO-4217 seria a melhoria.
- **Os triggers do ledger** custam algumas consultas indexadas por escrita. Seria preciso medir sob carga real.
- **Fora de escopo, como pede o enunciado:** reversão parcial e autenticação real (ver a seção 13).
