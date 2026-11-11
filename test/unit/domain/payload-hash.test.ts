import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../src/domain/shared/canonical-json';
import {
  WagerTransactionKind as Kind,
  hashOpeningPayload,
  hashWagerPayload,
  type WagerPayload,
} from '../../../src/domain/wagering';

const payload = (o: Partial<WagerPayload> = {}): WagerPayload => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: Kind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
  ...o,
});

describe('canonicalJson', () => {
  test('ordena as chaves e não tem espaços', () => {
    expect(canonicalJson({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
  });

  test('mesma informação em ordens diferentes vira o mesmo texto (o que JSON.stringify não garante)', () => {
    const x = { a: '1', nested: { y: true, x: null } };
    const y = { nested: { x: null, y: true }, a: '1' };
    expect(JSON.stringify(x)).not.toBe(JSON.stringify(y));
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  test('arrays mantêm a ordem', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
  });

  test('omite chaves undefined', () => {
    expect(canonicalJson({ a: '1', b: undefined })).toBe('{"a":"1"}');
  });

  test('escapa strings como JSON', () => {
    expect(canonicalJson({ a: 'aspas " e acentuação' })).toBe('{"a":"aspas \\" e acentuação"}');
  });

  test.each([
    ['número', { a: 1 }],
    ['Date', { a: new Date() }],
    ['bigint', { a: 1n }],
    ['instância de classe', { a: new (class Foo {})() }],
  ])('recusa %s', (_, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe('hashWagerPayload', () => {
  test('é o SHA-256 hex do JSON canônico (algoritmo documentado e reproduzível)', () => {
    const expectedText =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a",' +
      '"roundId":"round-987","walletId":"wallet-1"}';
    const expected = createHash('sha256').update(expectedText).digest('hex');
    expect(hashWagerPayload(payload())).toBe(expected);
    expect(hashWagerPayload(payload())).toMatch(/^[0-9a-f]{64}$/);
  });

  test('determinístico', () => {
    expect(hashWagerPayload(payload())).toBe(hashWagerPayload(payload()));
  });

  test.each([
    ['valor', { money: { amount: '25.01', currency: 'BRL' } }],
    ['moeda', { money: { amount: '25.00', currency: 'USD' } }],
    ['kind', { kind: Kind.Win }],
    ['wallet', { walletId: 'wallet-2' }],
    ['rodada', { roundId: 'round-988' }],
    ['referência', { kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' }],
  ])('muda quando muda o %s', (_, override) => {
    expect(hashWagerPayload(payload(override))).not.toBe(hashWagerPayload(payload()));
  });

  test('ignora campos de transporte (idempotencyKey, messageId...) — HTTP e SQS geram o mesmo hash', () => {
    const fromSqs = { ...payload(), idempotencyKey: 'provider-a:transaction-123', messageId: 'msg-1' };
    expect(hashWagerPayload(fromSqs)).toBe(hashWagerPayload(payload()));
  });

  test('referência ausente e undefined são a mesma coisa', () => {
    expect(hashWagerPayload(payload({ referenceExternalTransactionId: undefined }))).toBe(
      hashWagerPayload(payload()),
    );
  });
});

describe('hashOpeningPayload', () => {
  test('hash válido e diferente para valores diferentes', () => {
    const a = hashOpeningPayload({ walletId: 'w', playerId: 'p', money: { amount: '10.00', currency: 'BRL' } });
    const b = hashOpeningPayload({ walletId: 'w', playerId: 'p', money: { amount: '20.00', currency: 'BRL' } });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
