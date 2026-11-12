import {
  BusinessRuleViolationError,
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InboxMessageConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
} from "../../application/errors";
import {
  ConcurrentWriteConflictError,
  TransientInfrastructureError,
} from "../../application/ports/repositories";

/**
 * O que o consumer faz com uma mensagem cujo processamento LANÇOU erro.
 * (Transação REJECTED não é erro: o use case devolve o resultado e o consumer dá ack.)
 *
 *  - ack   → apaga da fila. A decisão é final e não há nada a reprocessar.
 *  - retry → devolve à fila depois de `delaySeconds` (ChangeMessageVisibility).
 *  - dlq   → copia para a DLQ com o motivo e apaga da fila principal.
 */
export type FailureDecision =
  | { action: "ack"; reason: string }
  | { action: "retry"; delaySeconds: number }
  | { action: "dlq"; reason: string };

export interface FailureContext {
  /** quantas vezes a SQS já entregou esta mensagem (ApproximateReceiveCount, começa em 1) */
  receiveCount: number;
  /** limite de entregas: ao atingir, a mensagem vai para a DLQ em vez de outro retry */
  maxAttempts: number;
  /** backoff exponencial: base * 2^(receiveCount - 1), limitado a maxDelaySeconds */
  baseDelaySeconds: number;
  maxDelaySeconds: number;
}

/** Backoff exponencial com teto. receiveCount 1 → base, 2 → 2×base, 3 → 4×base... */
export function retryDelaySeconds(ctx: FailureContext): number {
  return Math.min(
    ctx.baseDelaySeconds * 2 ** (ctx.receiveCount - 1),
    ctx.maxDelaySeconds,
  );
}

/**
 * ============================================================================
 *  DESAFIO 5 — ack, retry ou DLQ? (~30 min)
 * ============================================================================
 *
 * A seção 10 pede que o consumer distinga três tipos de erro. A pergunta que
 * separa os três é: "se eu processar esta mesma mensagem de novo, pode dar certo?"
 *
 *  1. NEGÓCIO (terminal → ack): a regra de negócio disse NÃO e vai continuar dizendo.
 *       BusinessRuleViolationError (ex.: moeda diferente da wallet).
 *       reason = o `code` do erro.
 *
 *  2. PERMANENTE (→ dlq): a MENSAGEM tem problema. Reprocessar nunca resolve, e
 *     ninguém registrou nada; alguém precisa olhar. A DLQ guarda a evidência.
 *       InvalidPayloadError (inclui JSON quebrado), WalletNotFoundError,
 *       IdempotencyConflictError, DuplicateExternalTransactionError,
 *       InboxMessageConflictError.
 *       reason = o `code` do erro.
 *
 *  3. TRANSITÓRIO (→ retry com backoff): o MUNDO tem problema (banco caiu,
 *     deadlock, lock timeout). A mesma mensagem, mais tarde, deve funcionar.
 *       TransientInfrastructureError, ConcurrentWriteConflictError
 *       delaySeconds = retryDelaySeconds(ctx)
 *
 *  4. DESCONHECIDO (qualquer outro erro, ex.: bug): trate como transitório.
 *     Pense: por que isso é mais seguro que mandar direto para a DLQ?
 *
 *  LIMITE: se for retry (3 ou 4) e `receiveCount >= maxAttempts`, não tem
 *  mais retry: vai para a dlq com reason = 'MAX_ATTEMPTS_EXCEEDED'.
 *
 * Dicas:
 *  - Use `instanceof` (nunca compare mensagem de erro).
 *  - Os três erros "de conflito" (IdempotencyConflict, DuplicateExternal, InboxMessageConflict)
 *    viraram 409 na API. Por que aqui eles vão para a DLQ e não para o ack?
 *    (pista: no HTTP o provedor RECEBE o 409 e decide; na fila, quem fica sabendo?)
 *
 * Perguntas para o guia:
 *  - Por que uma REJECTED (saldo insuficiente) nem chega nesta função?
 *  - E se o ack (DeleteMessage) falhar DEPOIS do commit? (é o desafio 6)
 *
 * Pronto quando: bun test test/unit/interfaces/classify-failure.test.ts passar.
 */
export function classifyFailure(
  error: unknown,
  ctx: FailureContext,
): FailureDecision {
  if (error instanceof BusinessRuleViolationError) {
    return {
      action: "ack",
      reason: error.code,
    };
  }

  if (
    error instanceof InvalidPayloadError ||
    error instanceof WalletNotFoundError ||
    error instanceof IdempotencyConflictError ||
    error instanceof DuplicateExternalTransactionError ||
    error instanceof InboxMessageConflictError
  ) {
    return {
      action: "dlq",
      reason: error.code,
    };
  }

  if (ctx.receiveCount >= ctx.maxAttempts) {
    return {
      action: "dlq",
      reason: "MAX_ATTEMPTS_EXCEEDED",
    };
  }

  const delay = retryDelaySeconds(ctx);

  return {
    action: "retry",
    delaySeconds: delay,
  };
}
