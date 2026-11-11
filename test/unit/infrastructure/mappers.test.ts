// Mappers da inbox
import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/domain/messaging';
import { inboxToDomain, inboxToRow } from '../../../src/infrastructure/persistence/mappers';

const T0 = new Date('2026-11-11T12:00:00Z');
const T1 = new Date('2026-11-11T12:00:01Z');

const received = () =>
  InboxMessage.receive({ consumerName: 'wager-transactions', messageId: 'msg-1', payloadHash: 'ab'.repeat(32), receivedAt: T0 });

describe('mappers da inbox', () => {
  test('mensagem ainda não processada: processedAt vira null na linha', () => {
    expect(inboxToRow(received())).toEqual({
      consumerName: 'wager-transactions',
      messageId: 'msg-1',
      payloadHash: 'ab'.repeat(32),
      receivedAt: T0,
      processedAt: null,
    });
  });

  test('mensagem processada: processedAt vai para a linha', () => {
    const m = received();
    m.markProcessed(T1);
    expect(inboxToRow(m).processedAt).toEqual(T1);
  });

  test('linha -> domínio: null vira undefined', () => {
    const m = inboxToDomain({
      consumerName: 'wager-transactions',
      messageId: 'msg-1',
      payloadHash: 'ab'.repeat(32),
      receivedAt: T0,
      processedAt: null,
    });
    expect(m.isProcessed()).toBe(false);
    expect(m.processedAt).toBeUndefined();
  });

  test('ida e volta preserva tudo', () => {
    const m = received();
    m.markProcessed(T1);
    expect(inboxToDomain(inboxToRow(m)).toState()).toEqual(m.toState());
  });
});
