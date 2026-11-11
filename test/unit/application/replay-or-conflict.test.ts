// DESAFIO 4 — vermelho até replayOrConflict ser implementado.
import { describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../../src/application/errors';
import { replayOrConflict } from '../../../src/application/wagering/wager-transaction-result';
import { Money } from '../../../src/domain/money';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wagering';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

function existing(idempotencyKey = 'provider-a:ext-1') {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey,
    payloadHash: HASH,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: new Date('2026-11-11T12:00:00Z'),
  });
}

describe('replayOrConflict', () => {
  test('mesmo conteúdo: devolve o resultado ORIGINAL marcado como replay', () => {
    const tx = existing();
    tx.markProcessed({ observedBalance: brl('75.00'), at: new Date() });
    expect(replayOrConflict(tx, HASH)).toEqual({
      transactionId: 'tx-1',
      status: Status.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    });
  });

  test('replay de uma rejeição devolve a mesma rejeição', () => {
    const tx = existing();
    tx.reject(FailureCode.InsufficientFunds, brl('10.00'));
    const result = replayOrConflict(tx, HASH);
    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.idempotentReplay).toBe(true);
  });

  test('conteúdo diferente: conflito, e NÃO replay', () => {
    const tx = existing();
    tx.markProcessed({ observedBalance: brl('75.00'), at: new Date() });
    expect(() => replayOrConflict(tx, OTHER_HASH)).toThrow(IdempotencyConflictError);
  });

  test('o erro de conflito carrega a key DA TRANSAÇÃO (não um valor fixo)', () => {
    const tx = existing('provider-z:outra-key-42');
    try {
      replayOrConflict(tx, OTHER_HASH);
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(IdempotencyConflictError);
      expect((error as IdempotencyConflictError).idempotencyKey).toBe('provider-z:outra-key-42');
    }
  });
});
