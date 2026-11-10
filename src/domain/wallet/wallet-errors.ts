import { DomainError } from '../shared/domain-error';

/**
 * Saldo insuficiente para um débito.
 *
 * O code aqui é genérico de propósito: a Wallet não sabe POR QUE está debitando.
 * Quem traduz para o failureCode final é o caso de uso:
 *   BET sem saldo           -> INSUFFICIENT_FUNDS
 *   reversão que negativaria -> REVERSAL_WOULD_OVERDRAW  (regra 7.9: códigos distintos)
 */
export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';

  constructor(
    readonly walletId: string,
    readonly balance: string,
    readonly requested: string,
  ) {
    super(`Wallet ${walletId} has insufficient balance`);
  }
}

/** Movimentação com valor zero ou negativo. */
export class NonPositiveAmountError extends DomainError {
  readonly code = 'NON_POSITIVE_AMOUNT';

  constructor(readonly amount: string) {
    super(`Wallet movements require a positive amount, got ${amount}`);
  }
}

/** Saldo inicial negativo na abertura. */
export class InvalidInitialBalanceError extends DomainError {
  readonly code = 'INVALID_INITIAL_BALANCE';

  constructor(readonly amount: string) {
    super(`Initial balance must not be negative, got ${amount}`);
  }
}

/** Lançamento com aritmética ou moedas inconsistentes. Indica bug, não regra de negócio. */
export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';

  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}
