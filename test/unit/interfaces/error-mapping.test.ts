import { describe, expect, test } from 'bun:test';
import {
  BusinessRuleViolationError,
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { ConcurrentWriteConflictError, TransientInfrastructureError } from '../../../src/application/ports/repositories';
import { FailureCode, WagerTransactionStatus as Status } from '../../../src/domain/wagering';
import { mapError, statusForTransaction } from '../../../src/interfaces/http/error-mapping';

describe('mapError: cada situação tem um status próprio (seção 9)', () => {
  test.each([
    ['payload inválido', new InvalidPayloadError('INVALID_FIELD', 'x'), 400, false],
    ['wallet inexistente', new WalletNotFoundError('w'), 404, false],
    ['transação inexistente', new TransactionNotFoundError('t'), 404, false],
    ['conflito de idempotência', new IdempotencyConflictError('k'), 409, false],
    ['externalId com outra key', new DuplicateExternalTransactionError('p', 'e'), 409, false],
    ['wallet duplicada', new WalletAlreadyExistsError('p', 'BRL', 'w'), 409, false],
    ['regra de negócio', new BusinessRuleViolationError(FailureCode.CurrencyMismatch, 'x'), 422, false],
    ['conflito de escrita após retries', new ConcurrentWriteConflictError(new Error()), 503, true],
    ['infra indisponível', new TransientInfrastructureError(new Error()), 503, true],
    ['bug inesperado', new Error('boom'), 500, true],
  ])('%s', (_name, error, status, retryable) => {
    const mapping = mapError(error);
    expect(mapping.status).toBe(status as number);
    expect(mapping.retryable).toBe(retryable as boolean);
  });

  test('erro inesperado não vaza detalhes internos', () => {
    expect(mapError(new Error('relation "wallets" does not exist')).message).toBe('Unexpected error');
  });
});

describe('statusForTransaction: o status vem do estado gravado (replay = mesmo status)', () => {
  test.each([
    [Status.Processed, 200],
    [Status.PendingReference, 202],
    [Status.Rejected, 422],
  ])('%s → %d', (status, http) => {
    expect(statusForTransaction(status)).toBe(http);
  });
});
