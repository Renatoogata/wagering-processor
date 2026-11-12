import { describe, expect, test } from 'bun:test';
import {
  BusinessRuleViolationError,
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InboxMessageConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { ConcurrentWriteConflictError, TransientInfrastructureError } from '../../../src/application/ports/repositories';
import { FailureCode } from '../../../src/domain/wagering';
import {
  classifyFailure,
  retryDelaySeconds,
  type FailureContext,
} from '../../../src/interfaces/messaging/classify-failure';

const ctx = (receiveCount: number): FailureContext => ({
  receiveCount,
  maxAttempts: 4,
  baseDelaySeconds: 2,
  maxDelaySeconds: 60,
});

describe('DESAFIO 5: classifyFailure', () => {
  describe('negócio → ack (a regra disse não, e vai continuar dizendo)', () => {
    test('moeda diferente da wallet', () => {
      const error = new BusinessRuleViolationError(FailureCode.CurrencyMismatch, 'BRL wallet, USD operation');
      expect(classifyFailure(error, ctx(1))).toEqual({ action: 'ack', reason: FailureCode.CurrencyMismatch });
    });

    test('negócio não depende de quantas vezes já tentou', () => {
      const error = new BusinessRuleViolationError(FailureCode.CurrencyMismatch, 'x');
      expect(classifyFailure(error, ctx(4)).action).toBe('ack');
    });
  });

  describe('permanente → dlq (a mensagem tem problema; alguém precisa olhar)', () => {
    const cases: [string, Error, string][] = [
      ['JSON quebrado / payload inválido', new InvalidPayloadError('INVALID_MESSAGE', 'bad json'), 'INVALID_MESSAGE'],
      ['wallet inexistente', new WalletNotFoundError('w-1'), 'WALLET_NOT_FOUND'],
      ['key reutilizada com outro conteúdo', new IdempotencyConflictError('k-1'), 'IDEMPOTENCY_CONFLICT'],
      [
        'mesmo externalId com outra key',
        new DuplicateExternalTransactionError('provider-a', 'tx-1'),
        'DUPLICATE_EXTERNAL_TRANSACTION',
      ],
      ['messageId repetido com outro conteúdo', new InboxMessageConflictError('c', 'm-1'), 'INBOX_MESSAGE_CONFLICT'],
    ];

    for (const [name, error, reason] of cases) {
      test(name, () => {
        expect(classifyFailure(error, ctx(1))).toEqual({ action: 'dlq', reason });
      });
    }
  });

  describe('transitório → retry com backoff exponencial', () => {
    test('banco fora do ar, 1ª entrega: espera a base', () => {
      const error = new TransientInfrastructureError(new Error('ECONNREFUSED'));
      expect(classifyFailure(error, ctx(1))).toEqual({ action: 'retry', delaySeconds: 2 });
    });

    test('conflito de escrita concorrente, 3ª entrega: 2 * 2^2 = 8s', () => {
      const error = new ConcurrentWriteConflictError(new Error('deadlock'));
      expect(classifyFailure(error, ctx(3))).toEqual({ action: 'retry', delaySeconds: 8 });
    });

    test('erro desconhecido (bug?) também é retry: na dúvida, não descarta', () => {
      expect(classifyFailure(new Error('boom'), ctx(2))).toEqual({ action: 'retry', delaySeconds: 4 });
    });
  });

  describe('limite de tentativas', () => {
    test('transitório na última entrega permitida → dlq', () => {
      const error = new TransientInfrastructureError(new Error('ECONNREFUSED'));
      expect(classifyFailure(error, ctx(4))).toEqual({ action: 'dlq', reason: 'MAX_ATTEMPTS_EXCEEDED' });
    });

    test('desconhecido além do limite → dlq', () => {
      expect(classifyFailure(new Error('boom'), ctx(9))).toEqual({ action: 'dlq', reason: 'MAX_ATTEMPTS_EXCEEDED' });
    });

    test('uma entrega antes do limite ainda é retry', () => {
      expect(classifyFailure(new Error('boom'), ctx(3)).action).toBe('retry');
    });
  });
});

describe('retryDelaySeconds (já pronto)', () => {
  test('dobra a cada entrega e respeita o teto', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelaySeconds(ctx(n)))).toEqual([2, 4, 8, 16, 32, 60, 60]);
  });
});
