import type { MoneyProps } from '../../domain/money';
import type { FailureCode, WagerTransaction, WagerTransactionStatus } from '../../domain/wagering';
import { IdempotencyConflictError } from '../errors';

/** O que a API e o consumer devolvem ao provedor (seção 9, "Submeter transação"). */
export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** saldo observado quando a transação foi decidida (o ORIGINAL, mesmo num replay — regra 7.7) */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export function toResult(tx: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.observedBalance && { balance: tx.observedBalance.toJSON() }),
    ...(tx.failureCode && { failureCode: tx.failureCode }),
    idempotentReplay,
  };
}

/**
 * ============================================================================
 *  DESAFIO 4 — replay ou conflito? (o coração da idempotência, ~10 min)
 * ============================================================================
 *
 * Chegou uma requisição cuja Idempotency-Key JÁ existe no banco (`existing`).
 * Duas possibilidades:
 *
 *  1. o conteúdo é o MESMO (o hash bate) → é um REENVIO legítimo (o provedor não
 *     recebeu a nossa resposta e mandou de novo). Devolva o resultado ORIGINAL,
 *     marcado como replay. Nada é processado de novo, nenhum centavo se move.
 *
 *  2. o conteúdo é DIFERENTE → o provedor reutilizou a key para outra operação.
 *     Isso NÃO é replay: lance IdempotencyConflictError com a key.
 *
 * Ferramentas que você já tem:
 *  - `existing.matchesPayload(payloadHash)` (WagerTransaction)
 *  - `toResult(tx, idempotentReplay)` (logo acima)
 *  - `IdempotencyConflictError` (importado)
 *
 * Pergunta para o guia: por que devolver o saldo ORIGINAL, e não o saldo atual da wallet?
 *
 * Pronto quando: bun test test/unit/application/replay-or-conflict.test.ts passar.
 */
export function replayOrConflict(existing: WagerTransaction, payloadHash: string): WagerTransactionResult {
  void existing;
  void payloadHash;
  void IdempotencyConflictError;
  throw new Error('TODO(desafio 4): implementar replayOrConflict');
}
