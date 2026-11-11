import { EntitySchema } from '@mikro-orm/core';

/**
 * Modelos de PERSISTÊNCIA: o formato das linhas do banco, sem nenhuma regra.
 *
 * Por que não mapear as classes de domínio direto no MikroORM?
 *  - o domínio tem construtor privado, getters e invariantes; o ORM quer criar
 *    objetos e escrever propriedades livremente — os dois puxariam a classe em
 *    direções opostas;
 *  - assim o domínio não depende do ORM (nenhum decorator lá dentro).
 *
 * O custo é um mapper (mappers.ts) traduzindo domínio <-> linha. O domínio já
 * expõe as duas pontas: `toState()` e `rehydrate()`.
 *
 * EntitySchema (e não decorators) mantém tudo explícito e funciona sem
 * metadata de reflexão. Valores monetários (numeric) chegam como STRING ("25.00"),
 * nunca number: o MikroORM mapeia `decimal` para string por padrão.
 *
 * Os relacionamentos ficam como colunas simples (ids), sem `ManyToOne`: as FKs
 * compostas vivem no schema, e o caso de uso controla a ordem das escritas.
 */

const timestamptz = { type: 'datetime', columnType: 'timestamptz' } as const;
const money = { type: 'decimal', columnType: 'numeric(20,2)' } as const;

// ---------------------------------------------------------------- wallets

export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  class: WalletRow,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { ...money },
    version: { type: 'integer' },
    createdAt: { ...timestamptz },
    updatedAt: { ...timestamptz },
  },
});

// ---------------------------------------------------------------- wager_transactions

export class WagerTransactionRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  currency!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  amount!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  observedBalance!: string | null;
  processedAt!: Date | null;
  attempts!: number;
  nextAttemptAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  class: WagerTransactionRow,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    roundId: { type: 'string', nullable: true },
    gameId: { type: 'string', nullable: true },
    kind: { type: 'string' },
    amount: { ...money },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    observedBalance: { ...money, nullable: true },
    processedAt: { ...timestamptz, nullable: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamptz, nullable: true },
    createdAt: { ...timestamptz },
    updatedAt: { ...timestamptz },
  },
});

// ---------------------------------------------------------------- wallet_ledger_entries

export class LedgerEntryRow {
  id!: string;
  /** gerado pelo banco (identity); base do cursor da paginação */
  seq!: bigint;
  walletId!: string;
  currency!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
  class: LedgerEntryRow,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    // GENERATED ALWAYS AS IDENTITY: o MikroORM não pode tentar escrever nesta coluna
    seq: { type: 'bigint', generated: 'always as identity' },
    walletId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: { ...money },
    balanceBefore: { ...money },
    balanceAfter: { ...money },
    walletVersion: { type: 'integer' },
    createdAt: { ...timestamptz },
  },
});

// ---------------------------------------------------------------- inbox_messages

export class InboxMessageRow {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRow>({
  class: InboxMessageRow,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: { ...timestamptz },
    processedAt: { ...timestamptz, nullable: true },
  },
});

// ---------------------------------------------------------------- outbox_messages

export class OutboxMessageRow {
  id!: string;
  seq!: bigint;
  aggregateId!: string;
  eventType!: string;
  eventVersion!: number;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
  lastError!: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  class: OutboxMessageRow,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    seq: { type: 'bigint', generated: 'always as identity' },
    aggregateId: { type: 'string' },
    eventType: { type: 'string' },
    eventVersion: { type: 'integer' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { ...timestamptz },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamptz },
    publishedAt: { ...timestamptz, nullable: true },
    lastError: { type: 'string', columnType: 'text', nullable: true },
  },
});

export const persistenceEntities = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
