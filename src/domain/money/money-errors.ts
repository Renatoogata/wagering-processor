import { DomainError } from '../shared/domain-error';

/** Valor monetário mal formado (formato, escala, sinal, tamanho). */
export class InvalidMoneyAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';

  constructor(
    readonly received: unknown,
    readonly reason: string,
  ) {
    super(`Invalid money amount: ${reason}`);
  }
}

/** Código de moeda fora do formato ISO-4217 (3 letras maiúsculas). */
export class InvalidCurrencyError extends DomainError {
  readonly code = 'INVALID_CURRENCY';

  constructor(readonly received: unknown) {
    super(`Invalid currency: expected ISO-4217 code (e.g. "BRL")`);
  }
}

/** Operação entre moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}
