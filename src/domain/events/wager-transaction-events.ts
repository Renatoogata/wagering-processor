import type { MoneyProps } from '../money';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wagering';
import { IntegrationEvent, InvalidEventSourceError, type EventContext } from './integration-event';

/**
 * Campos comuns aos eventos de transação: o suficiente para o consumidor
 * identificar a operação do provedor sem precisar consultar a nossa API.
 * Opcionais viram `null` (e não somem do JSON), para o formato ser sempre o mesmo.
 */
export interface WagerTransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function baseData(tx: WagerTransaction): WagerTransactionEventBase {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function assertStatus(eventType: string, tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) {
    throw new InvalidEventSourceError(eventType, `transaction ${tx.id} is ${tx.status}, expected ${expected}`);
  }
}

// ---------------------------------------------------------------- Processed

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  referenceTransactionId: string | null;
  /** saldo logo após a aplicação (para LOSS, o saldo inalterado) */
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (que não mexe no saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus('WagerTransactionProcessed', tx, WagerTransactionStatus.Processed);
    // markProcessed exige os dois; se faltarem, o estado foi corrompido
    if (!tx.observedBalance || !tx.processedAt) {
      throw new InvalidEventSourceError('WagerTransactionProcessed', 'missing observedBalance/processedAt');
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        balanceAfter: tx.observedBalance.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}

// ---------------------------------------------------------------- Rejected

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  failureCode: FailureCode;
  /** presente quando a rejeição olhou o saldo (ex.: INSUFFICIENT_FUNDS) */
  observedBalance: MoneyProps | null;
}

/** Rejeição por regra de negócio (status REJECTED). FAILED de infraestrutura não gera este evento. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus('WagerTransactionRejected', tx, WagerTransactionStatus.Rejected);
    if (!tx.failureCode) {
      throw new InvalidEventSourceError('WagerTransactionRejected', 'missing failureCode');
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        failureCode: tx.failureCode,
        observedBalance: tx.observedBalance?.toJSON() ?? null,
      },
    });
  }
}

// ---------------------------------------------------------------- PendingReference

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventBase {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

/** REFUND/ROLLBACK chegou antes da referência e ficou aguardando (seção 7.1). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus('WagerTransactionPendingReference', tx, WagerTransactionStatus.PendingReference);
    if (!tx.referenceExternalTransactionId || !tx.nextAttemptAt) {
      throw new InvalidEventSourceError('WagerTransactionPendingReference', 'missing reference/nextAttemptAt');
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        attempts: tx.attempts,
        nextAttemptAt: tx.nextAttemptAt.toISOString(),
      },
    });
  }
}
