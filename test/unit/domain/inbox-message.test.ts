// InboxMessage
import { describe, expect, test } from 'bun:test';
import {
  InboxAlreadyProcessedError,
  InboxMessage,
  InvalidInboxMessageError,
  type ReceiveInboxProps,
} from '../../../src/domain/messaging';

const HASH = 'ab'.repeat(32);
const T0 = new Date('2026-11-11T12:00:00Z');
const T1 = new Date('2026-11-11T12:00:01Z');

const props = (o: Partial<ReceiveInboxProps> = {}): ReceiveInboxProps => ({
  messageId: 'msg-1',
  consumerName: 'wager-transactions',
  payloadHash: HASH,
  receivedAt: T0,
  ...o,
});

describe('InboxMessage.receive', () => {
  test('nasce não processada', () => {
    const m = InboxMessage.receive(props());
    expect(m.messageId).toBe('msg-1');
    expect(m.consumerName).toBe('wager-transactions');
    expect(m.payloadHash).toBe(HASH);
    expect(m.receivedAt).toEqual(T0);
    expect(m.isProcessed()).toBe(false);
    expect(m.processedAt).toBeUndefined();
  });

  test.each([
    ['messageId vazio', { messageId: '' }],
    ['consumerName vazio', { consumerName: '' }],
    ['hash curto', { payloadHash: 'ab' }],
    ['hash com maiúsculas', { payloadHash: 'AB'.repeat(32) }],
    ['hash não hexadecimal', { payloadHash: 'zz'.repeat(32) }],
  ])('rejeita %s', (_, override) => {
    expect(() => InboxMessage.receive(props(override))).toThrow(InvalidInboxMessageError);
  });
});

describe('InboxMessage.markProcessed', () => {
  test('marca uma vez', () => {
    const m = InboxMessage.receive(props());
    m.markProcessed(T1);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(T1);
  });

  test('marcar duas vezes é erro', () => {
    const m = InboxMessage.receive(props());
    m.markProcessed(T1);
    expect(() => m.markProcessed(T1)).toThrow(InboxAlreadyProcessedError);
  });

  test('não pode ser processada antes de ser recebida', () => {
    const m = InboxMessage.receive(props({ receivedAt: T1 }));
    expect(() => m.markProcessed(T0)).toThrow(InvalidInboxMessageError);
  });
});

describe('InboxMessage.matchesPayload', () => {
  test('mesmo conteúdo = redelivery legítimo; conteúdo diferente = não', () => {
    const m = InboxMessage.receive(props());
    expect(m.matchesPayload(HASH)).toBe(true);
    expect(m.matchesPayload('cd'.repeat(32))).toBe(false);
  });
});

describe('InboxMessage.rehydrate', () => {
  test('não revalida e preserva o estado', () => {
    const state = { ...props(), processedAt: T1 };
    const m = InboxMessage.rehydrate(state);
    expect(m.isProcessed()).toBe(true);
    expect(m.toState()).toEqual(state);
  });
});

describe('InboxMessage — cópias defensivas', () => {
  test('mudar a Date de entrada não altera a mensagem', () => {
    const at = new Date(T0.getTime());
    const m = InboxMessage.receive(props({ receivedAt: at }));
    at.setFullYear(2000);
    expect(m.receivedAt).toEqual(T0);
  });

  test('mudar a Date devolvida pelo getter não altera a mensagem', () => {
    // cópia própria: assim o teste não altera o T0 compartilhado se a classe vazar a referência
    const m = InboxMessage.receive(props({ receivedAt: new Date(T0.getTime()) }));
    m.receivedAt.setFullYear(2000);
    expect(m.receivedAt).toEqual(new Date('2026-11-11T12:00:00Z'));
  });
});
