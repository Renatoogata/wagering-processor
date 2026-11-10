import { DomainError } from '../shared/domain-error';
import type { WagerTransactionStatus } from './wager-transaction-kind';

/**
 * Payload que nunca poderia ser uma transação válida (ex.: REFUND sem referência,
 * OPENING vindo de fora). Vira "payload inválido" na API, e nada é persistido.
 */
export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Tentativa de transição inválida (ex.: mexer em uma transação PROCESSED).
 * Não é caminho de negócio: indica bug no chamador.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(
    readonly transactionId: string,
    readonly currentStatus: WagerTransactionStatus,
    readonly attempted: string,
  ) {
    super(`Transaction ${transactionId} cannot ${attempted} from status ${currentStatus}`);
  }
}
