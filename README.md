# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK)
recebidas por **HTTP e SQS**, com idempotência persistente, ledger imutável, inbox,
outbox transacional e correção garantida com **múltiplas instâncias**.

> Decisões técnicas, trade-offs e limitações: veja [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Stack

Bun 1.x · TypeScript (strict) · NestJS · MikroORM · PostgreSQL 17 · SQS (FIFO + DLQ) via LocalStack · Docker Compose

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose v2

## Setup

```bash
cp .env.example .env
bun install
docker compose up -d --wait   # Postgres (porta 55432) + LocalStack (4566) com as filas criadas
bun run db:migrate
bun run start                 # http://localhost:3000
```

O processo sobe, junto com a API HTTP:

- o **consumer SQS** de `wager-transactions.fifo`;
- o **worker de referências pendentes**;
- o **relay da outbox**, que publica em `wagering-events.fifo`.

Cada um pode ser desligado por variável de ambiente (veja abaixo).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a aplicação (HTTP + consumer + workers) |
| `bun run dev` | idem, com reload |
| `bun run db:migrate` | aplica as migrations pendentes |
| `bun run db:rollback` | desfaz a última migration |
| `bun run typecheck` | checagem de tipos (`tsc --noEmit`) |
| `bun test` | **todos** os testes (exige `docker compose up`) |
| `bun run test:unit` | unidade (sem dependências externas) |
| `bun run test:integration` | integração contra Postgres e LocalStack reais |
| `bun run test:e2e` | API HTTP de ponta a ponta |
| `bun run test:concurrency` | 3 processos reais da aplicação, SIGKILL/SIGTERM e reinício |

## Variáveis de ambiente

| Variável | Padrão (`.env.example`) | Para quê |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:55432/wagering` | PostgreSQL |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | LocalStack |
| `SQS_WAGER_QUEUE_URL` / `SQS_WAGER_DLQ_URL` | filas `wager-transactions*.fifo` | entrada SQS e DLQ |
| `SQS_EVENTS_QUEUE_URL` | `wagering-events.fifo` | destino dos eventos da outbox |
| `SQS_CONSUMER_ENABLED` | `true` | `false` desliga o consumer |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | `false` desliga o relay da outbox |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | `false` desliga o worker de pendentes |

## Rodando várias instâncias

Todas compartilham só o Postgres e a SQS; basta mudar a porta:

```bash
PORT=3001 bun run start &
PORT=3002 bun run start &
PORT=3003 bun run start &
```

`SIGTERM` (Ctrl+C / `kill`) faz cada instância terminar o que está em andamento e devolver à fila
o que não começou. O teste `bun run test:concurrency` prova a correção com 3 processos reais.

## Exemplos

```bash
# criar wallet com saldo inicial
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# aposta (troque <walletId>); reenviar com a mesma Idempotency-Key devolve o resultado original
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
       "walletId":"<walletId>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'

# a mesma operação pela fila (MessageGroupId = walletId)
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id tx-2 \
  --message-body '{"messageId":"msg-tx-2","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"tx-2","idempotencyKey":"provider-a:tx-2",
    "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-1",
    "gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'

# eventos publicados pela outbox
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wagering-events.fifo --max-number-of-messages 10
```

## Endpoints

| Método e caminho | O que faz |
|---|---|
| `POST /wallets` | cria wallet (saldo inicial vira OPENING + CREDIT no ledger) |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | ledger paginado por cursor opaco |
| `POST /wallets/:walletId/reconciliation` | compara saldo × ledger (sinaliza, nunca corrige) |
| `POST /wagering/transactions` | submete uma operação (`Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | liveness · readiness (Postgres e SQS) |
| `GET /metrics` | métricas no formato Prometheus |

Mapeamento de status (200/201/202/400/404/409/422/503/500): veja `ARCHITECTURE.md`, seção 8.

## Estrutura

```
src/
  domain/              # Money, Wallet, WagerTransaction, ledger, eventos, inbox/outbox (sem Nest nem ORM)
  application/         # casos de uso e portas (UnitOfWork, repositórios, EventPublisher, Metrics)
  infrastructure/
    persistence/       # MikroORM: entidades, mappers, repositórios, migrations
    messaging/         # cliente SQS, publicador de eventos
    observability/     # medidores lidos do banco/fila para /metrics
  interfaces/
    http/              # controllers, filtro de erros, /metrics
    messaging/         # consumer SQS e classificação de falhas
    workers/           # PollingWorker e ciclo de vida (SIGTERM)
test/
  unit/ integration/ e2e/ concurrency/
docker/localstack/     # script que cria as filas FIFO + DLQ
```
