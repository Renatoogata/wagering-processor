# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK)
recebidas por HTTP e SQS, com idempotência persistente, ledger imutável e outbox transacional.

> Decisões técnicas, trade-offs e limitações: veja [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Stack

Bun 1.x · TypeScript (strict) · NestJS · MikroORM · PostgreSQL 17 · SQS via LocalStack · Docker Compose

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

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a API |
| `bun run dev` | sobe a API com reload |
| `bun run db:migrate` | aplica as migrations pendentes |
| `bun run db:rollback` | desfaz a última migration |
| `bun run typecheck` | checagem de tipos (`tsc --noEmit`) |
| `bun test` | todos os testes |
| `bun run test:unit` | testes de unidade |
| `bun run test:integration` | testes de integração (exige `docker compose up`) |

## Health checks

```bash
curl localhost:3000/health/live    # processo vivo
curl localhost:3000/health/ready   # Postgres e SQS alcançáveis (503 se não)
```

## Estrutura

```
src/
  domain/            # Money, Wallet, WagerTransaction, ledger — sem NestJS nem ORM
  application/       # use cases e portas
  infrastructure/
    persistence/     # MikroORM, repositórios, migrations
    messaging/       # SQS: consumer, outbox publisher
  interfaces/http/   # controllers
docker/localstack/   # script que cria as filas FIFO + DLQ
scripts/             # utilitários (migrations)
```
