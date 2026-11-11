import { InboxMessage, OutboxMessage } from "../../domain/messaging";
import type { IntegrationEventEnvelope } from "../../domain/events";
import { Money } from "../../domain/money";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering";
import {
  LedgerDirection,
  Wallet,
  WalletLedgerEntry,
} from "../../domain/wallet";
import type {
  InboxMessageRow,
  LedgerEntryRow,
  OutboxMessageRow,
  WagerTransactionRow,
  WalletRow,
} from "./entities";

/**
 * Mappers: traduzem domínio <-> linha do banco. SEM regra de negócio.
 *
 *  - toRow:   domínio -> `toState()` -> campos da linha (Money vira string "25.00");
 *  - toDomain: linha -> estado -> `rehydrate()` (não revalida: já foi validado ao nascer).
 *
 * Os `toRow` devolvem objetos simples (não instâncias de Row): o repositório decide
 * se usa para criar a linha (`em.create`) ou para atualizar uma já carregada (`em.assign`).
 */

type RowData<T> = Omit<T, "seq">;

const money = (amount: string, currency: string) =>
  Money.from({ amount, currency });
const orUndefined = <T>(value: T | null): T | undefined =>
  value === null ? undefined : value;

// ---------------------------------------------------------------- Wallet

export function walletToRow(wallet: Wallet): WalletRow {
  const s = wallet.toState();
  return {
    id: s.id,
    playerId: s.playerId,
    currency: s.currency,
    balance: s.balance.amount,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function walletToDomain(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: money(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

// ---------------------------------------------------------------- WagerTransaction

export function transactionToRow(
  tx: WagerTransaction,
  updatedAt: Date,
): WagerTransactionRow {
  const s = tx.toState();
  return {
    id: s.id,
    providerId: s.providerId,
    externalTransactionId: s.externalTransactionId,
    idempotencyKey: s.idempotencyKey,
    payloadHash: s.payloadHash,
    walletId: s.walletId,
    playerId: s.playerId,
    currency: s.money.currency,
    roundId: s.roundId ?? null,
    gameId: s.gameId ?? null,
    kind: s.kind,
    amount: s.money.amount,
    referenceExternalTransactionId: s.referenceExternalTransactionId ?? null,
    referenceTransactionId: s.referenceTransactionId ?? null,
    status: s.status,
    failureCode: s.failureCode ?? null,
    observedBalance: s.observedBalance?.amount ?? null,
    processedAt: s.processedAt ?? null,
    attempts: s.attempts,
    nextAttemptAt: s.nextAttemptAt ?? null,
    createdAt: s.createdAt,
    updatedAt,
  };
}

export function transactionToDomain(
  row: WagerTransactionRow,
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: orUndefined(row.roundId),
    gameId: orUndefined(row.gameId),
    kind: row.kind as WagerTransactionKind,
    money: money(row.amount, row.currency),
    referenceExternalTransactionId: orUndefined(
      row.referenceExternalTransactionId,
    ),
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: orUndefined(row.referenceTransactionId),
    failureCode: orUndefined(row.failureCode) as FailureCode | undefined,
    observedBalance:
      row.observedBalance === null
        ? undefined
        : money(row.observedBalance, row.currency),
    processedAt: orUndefined(row.processedAt),
    attempts: row.attempts,
    nextAttemptAt: orUndefined(row.nextAttemptAt),
  });
}

// ---------------------------------------------------------------- Ledger

export function ledgerEntryToRow(
  entry: WalletLedgerEntry,
): RowData<LedgerEntryRow> {
  return {
    id: entry.id,
    walletId: entry.walletId,
    currency: entry.money.currency,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.amount,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function ledgerEntryToDomain(row: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: money(row.amount, row.currency),
    balanceBefore: money(row.balanceBefore, row.currency),
    balanceAfter: money(row.balanceAfter, row.currency),
    walletVersion: row.walletVersion,
    createdAt: row.createdAt,
  });
}

// ---------------------------------------------------------------- Outbox

export function outboxToRow(message: OutboxMessage): RowData<OutboxMessageRow> {
  const s = message.toState();
  return {
    id: s.id,
    aggregateId: s.aggregateId,
    eventType: s.eventType,
    eventVersion: s.eventVersion,
    payload: s.payload as unknown as Record<string, unknown>,
    occurredAt: s.occurredAt,
    attempts: s.attempts,
    nextAttemptAt: s.nextAttemptAt,
    publishedAt: s.publishedAt ?? null,
    lastError: s.lastError ?? null,
  };
}

export function outboxToDomain(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    payload: row.payload as unknown as IntegrationEventEnvelope<unknown>,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    publishedAt: orUndefined(row.publishedAt),
    lastError: orUndefined(row.lastError),
  });
}

// ---------------------------------------------------------------- Inbox

export function inboxToRow(message: InboxMessage): InboxMessageRow {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    processedAt: message.processedAt ?? null,
    receivedAt: message.receivedAt,
  };
}

export function inboxToDomain(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: orUndefined(row.processedAt),
  });
}
