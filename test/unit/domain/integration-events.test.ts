import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind as Kind,
} from '../../../src/domain/wagering';
import {
  InvalidEventSourceError,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  type EventContext,
} from '../../../src/domain/events';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const T0 = new Date('2026-11-11T12:00:00Z');
const ctx: EventContext = { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: T0 };

function tx(kind: Kind = Kind.Bet, ref?: string) {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    ...(ref && { referenceExternalTransactionId: ref }),
    createdAt: T0,
  });
}

describe('IntegrationEvent — envelope', () => {
  test('toJSON segue o formato da seção 11', () => {
    const t = tx();
    t.markProcessed({ observedBalance: brl('75.00'), at: T0 });
    const json = WagerTransactionProcessed.from(t, { ...ctx, causationId: 'msg-9' }).toJSON();

    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'tx-1',
      correlationId: 'corr-1',
      causationId: 'msg-9',
      occurredAt: '2026-11-11T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: 'tx-1',
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: Kind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
        referenceTransactionId: null,
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        processedAt: '2026-11-11T12:00:00.000Z',
      },
    });
  });

  test('sem causationId a chave não aparece', () => {
    const t = tx();
    t.markProcessed({ observedBalance: brl('75.00'), at: T0 });
    expect('causationId' in WagerTransactionProcessed.from(t, ctx).toJSON()).toBe(false);
  });

  test('o envelope sobrevive a JSON.stringify/parse sem perder nada (sem bigint, sem Money)', () => {
    const t = tx();
    t.markProcessed({ observedBalance: brl('75.00'), at: T0 });
    const json = WagerTransactionProcessed.from(t, ctx).toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('data é imutável', () => {
    const t = tx();
    t.markProcessed({ observedBalance: brl('75.00'), at: T0 });
    expect(Object.isFrozen(WagerTransactionProcessed.from(t, ctx).data)).toBe(true);
  });
});

describe('cada evento só nasce do estado certo', () => {
  test('Processed exige PROCESSED', () => {
    expect(() => WagerTransactionProcessed.from(tx(), ctx)).toThrow(InvalidEventSourceError);
  });

  test('Rejected carrega failureCode e saldo observado', () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds, brl('10.00'));
    const e = WagerTransactionRejected.from(t, ctx);
    expect(e.eventType).toBe('WagerTransactionRejected');
    expect(e.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(e.data.observedBalance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('Rejected não aceita transação PROCESSED', () => {
    const t = tx();
    t.markProcessed({ observedBalance: brl('75.00'), at: T0 });
    expect(() => WagerTransactionRejected.from(t, ctx)).toThrow(InvalidEventSourceError);
  });

  test('PendingReference carrega referência, tentativas e próxima tentativa', () => {
    const t = tx(Kind.Refund, 'ext-bet-1');
    t.markPendingReference(new Date('2026-11-11T12:00:01Z'));
    const e = WagerTransactionPendingReference.from(t, ctx);
    expect(e.data.referenceExternalTransactionId).toBe('ext-bet-1');
    expect(e.data.attempts).toBe(1);
    expect(e.data.nextAttemptAt).toBe('2026-11-11T12:00:01.000Z');
  });
});
