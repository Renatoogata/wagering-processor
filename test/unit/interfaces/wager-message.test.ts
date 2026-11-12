import { describe, expect, test } from 'bun:test';
import { InvalidPayloadError } from '../../../src/application/errors';
import { hashWagerPayload } from '../../../src/domain/wagering';
import { parseWagerMessage } from '../../../src/interfaces/messaging/wager-message';

const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const envelope = { messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data };

function expectInvalid(body: string, code: string) {
  try {
    parseWagerMessage(body);
    throw new Error('should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidPayloadError);
    expect((error as InvalidPayloadError).code).toBe(code);
  }
}

describe('parseWagerMessage', () => {
  test('mensagem do enunciado (seção 10)', () => {
    const msg = parseWagerMessage(JSON.stringify(envelope));
    expect(msg.messageId).toBe('msg-123');
    expect(msg.idempotencyKey).toBe('provider-a:transaction-123');
    expect(msg.payload.kind).toBe('BET' as never);
    expect(msg.payload.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('idempotencyKey fica fora do payload: mesmo hash que a mesma operação via HTTP', () => {
    const { idempotencyKey: _, ...httpBody } = data;
    const msg = parseWagerMessage(JSON.stringify(envelope));
    expect(hashWagerPayload(msg.payload)).toBe(hashWagerPayload(httpBody as never));
  });

  test('JSON quebrado', () => expectInvalid('{not json', 'INVALID_MESSAGE'));
  test('tipo desconhecido', () => expectInvalid(JSON.stringify({ ...envelope, type: 'Other' }), 'INVALID_MESSAGE'));
  test('sem messageId', () => expectInvalid(JSON.stringify({ ...envelope, messageId: undefined }), 'INVALID_MESSAGE'));
  test('sem idempotencyKey', () =>
    expectInvalid(JSON.stringify({ ...envelope, data: { ...data, idempotencyKey: undefined } }), 'INVALID_IDEMPOTENCY_KEY'));
  test('amount numérico (float) é recusado', () =>
    expectInvalid(JSON.stringify({ ...envelope, data: { ...data, money: { amount: 25, currency: 'BRL' } } }), 'INVALID_FIELD'));
});
