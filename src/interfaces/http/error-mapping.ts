import { HttpStatus } from '@nestjs/common';
import {
  BusinessRuleViolationError,
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InvalidPayloadError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { ConcurrentWriteConflictError, TransientInfrastructureError } from '../../application/ports/repositories';
import { WagerTransactionStatus as Status } from '../../domain/wagering';

/**
 * MAPEAMENTO DE STATUS HTTP — o mesmo em TODOS os endpoints (seção 9).
 *
 * A pergunta que o status responde para o provedor é: "o que eu faço agora?"
 *
 *  | status | situação                                   | o provedor deve...                     |
 *  |--------|--------------------------------------------|----------------------------------------|
 *  | 200    | PROCESSED (novo ou replay)                 | seguir em frente                       |
 *  | 201    | wallet criada                              | seguir em frente                       |
 *  | 202    | PENDING_REFERENCE: aceito, decide depois   | consultar depois / esperar o evento    |
 *  | 400    | payload inválido                           | CORRIGIR; reenviar igual nunca funciona|
 *  | 404    | wallet/transação não existe                | corrigir a referência                  |
 *  | 409    | conflito (key reutilizada, wallet duplicada)| NÃO reenviar: é outra operação         |
 *  | 422    | rejeitada por regra de negócio             | não reenviar; a decisão é final        |
 *  | 503    | falha transitória de infraestrutura        | REENVIAR com a mesma key (é seguro)    |
 *  | 500    | bug inesperado                             | alertar; reenviar com a mesma key      |
 *
 * 422 serve tanto para REJECTED gravada (saldo insuficiente...) quanto para
 * BusinessRuleViolationError (moeda diferente): nos dois casos é "regra de negócio disse não".
 * A diferença está no corpo: REJECTED tem transactionId (foi gravada); a violação não.
 *
 * Replay devolve o MESMO status do original, porque o status vem do estado gravado.
 */
export interface ErrorMapping {
  status: HttpStatus;
  code: string;
  message: string;
  retryable: boolean;
}

export function mapError(error: unknown): ErrorMapping {
  if (error instanceof InvalidPayloadError) return client(HttpStatus.BAD_REQUEST, error);
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return client(HttpStatus.NOT_FOUND, error);
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof DuplicateExternalTransactionError ||
    error instanceof WalletAlreadyExistsError
  ) {
    return client(HttpStatus.CONFLICT, error);
  }
  if (error instanceof BusinessRuleViolationError) return client(HttpStatus.UNPROCESSABLE_ENTITY, error);

  // conflito de escrita que sobrou após os retries, ou banco indisponível: tente de novo
  if (error instanceof ConcurrentWriteConflictError || error instanceof TransientInfrastructureError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'TRANSIENT_FAILURE',
      message: 'Temporary failure; retry with the same Idempotency-Key',
      retryable: true,
    };
  }

  // não vaza detalhes internos (stack, SQL) para o cliente
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    message: 'Unexpected error',
    retryable: true,
  };
}

function client(status: HttpStatus, error: { code: string; message: string }): ErrorMapping {
  return { status, code: error.code, message: error.message, retryable: false };
}

/** Status de uma operação que FOI gravada (inclusive replay). */
export function statusForTransaction(status: Status): HttpStatus {
  switch (status) {
    case Status.Processed:
      return HttpStatus.OK;
    case Status.PendingReference:
      return HttpStatus.ACCEPTED;
    case Status.Rejected:
    case Status.Failed:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    default:
      return HttpStatus.OK;
  }
}
