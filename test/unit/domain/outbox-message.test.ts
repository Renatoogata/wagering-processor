import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money';
import { WagerTransaction, WagerTransactionKind as Kind } from '../../../src/domain/wagering';
import { WagerTransactionProcessed } from '../../../src/domain/events';
import {
  OutboxAlreadyPublishedError,
  OutboxMessage,
  OutboxRetryPolicy,
} from '../../../src/domain/messaging';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const T0 = new Date('2026-11-11T12:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

function processedEvent() {
  const tx = WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: T0,
  });
  tx.markProcessed({ observedBalance: brl('75.00'), at: T0 });
  return WagerTransactionProcessed.from(tx, { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: T0 });
}

describe('OutboxMessage.enqueue', () => {
  test('usa o eventId como id e nasce pendente e devida', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    expect(msg.id).toBe('evt-1');
    expect(msg.aggregateId).toBe('tx-1');
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.eventVersion).toBe(1);
    expect(msg.attempts).toBe(0);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
  });

  test('payload é o envelope serializado e congelado', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    expect(msg.payload.eventType).toBe('WagerTransactionProcessed');
    expect(msg.payload.occurredAt).toBe('2026-11-11T12:00:00.000Z');
    expect((msg.payload.data as { money: unknown }).money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(Object.isFrozen(msg.payload)).toBe(true);
  });
});

describe('OutboxMessage — publicação', () => {
  test('markPublished tira da fila', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    msg.markPublished(plus(10));
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(plus(10_000))).toBe(false);
    expect(msg.publishedAt?.toISOString()).toBe(plus(10).toISOString());
  });

  test('publicar duas vezes é bug', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    msg.markPublished(T0);
    expect(() => msg.markPublished(T0)).toThrow(OutboxAlreadyPublishedError);
    expect(() => msg.scheduleRetry(T0)).toThrow(OutboxAlreadyPublishedError);
  });
});

describe('OutboxMessage.scheduleRetry', () => {
  test('backoff exponencial 1s, 2s, 4s... a partir de now', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    msg.scheduleRetry(T0, 'ECONNREFUSED');
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt).toEqual(plus(1_000));
    expect(msg.isDue(plus(999))).toBe(false);
    expect(msg.isDue(plus(1_000))).toBe(true);
    expect(msg.lastError).toBe('ECONNREFUSED');

    msg.scheduleRetry(T0);
    expect(msg.nextAttemptAt).toEqual(plus(2_000));
    msg.scheduleRetry(T0);
    expect(msg.nextAttemptAt).toEqual(plus(4_000));
  });

  test('não desiste nunca: o atraso para no teto, as tentativas continuam', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    for (let i = 0; i < 50; i++) msg.scheduleRetry(T0);
    expect(msg.attempts).toBe(50);
    expect(msg.isPending()).toBe(true);
    expect(msg.nextAttemptAt).toEqual(plus(60_000));
  });

  test('política customizável', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    msg.scheduleRetry(T0, undefined, new OutboxRetryPolicy({ baseDelayMs: 10, maxDelayMs: 15 }));
    expect(msg.nextAttemptAt).toEqual(plus(10));
    msg.scheduleRetry(T0, undefined, new OutboxRetryPolicy({ baseDelayMs: 10, maxDelayMs: 15 }));
    expect(msg.nextAttemptAt).toEqual(plus(15));
  });

  test('trunca o texto de erro', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    msg.scheduleRetry(T0, 'x'.repeat(2_000));
    expect(msg.lastError?.length).toBe(500);
  });
});

describe('OutboxMessage.rehydrate', () => {
  test('ida e volta pelo toState preserva tudo', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    msg.scheduleRetry(T0, 'boom');
    const back = OutboxMessage.rehydrate(msg.toState());
    expect(back.toState()).toEqual(msg.toState());
  });

  test('getters devolvem cópias de Date', () => {
    const msg = OutboxMessage.enqueue(processedEvent());
    msg.nextAttemptAt.setFullYear(2000);
    expect(msg.nextAttemptAt).toEqual(T0);
  });
});
