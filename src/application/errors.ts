import type { FailureCode } from '../domain/wagering';

/**
 * Erros da camada de aplicação. Cada classe corresponde a UMA situação que o
 * provedor precisa distinguir (seção 9, "Status HTTP"), e a API/consumer
 * traduz pela classe, nunca pela mensagem:
 *
 *  - InvalidPayloadError        → payload nunca será aceito como está (corrigir). Nada gravado.
 *  - IdempotencyConflictError   → mesma key com conteúdo diferente (não é replay). Nada gravado.
 *  - WalletNotFoundError        → a wallet não existe. Nada gravado.
 *  - BusinessRuleViolationError → regra de negócio que NÃO pode ser gravada como REJECTED
 *                                 (ex.: moeda diferente da wallet: a FK do banco impede gravar).
 *
 * Rejeições que PODEM ser gravadas (saldo insuficiente, referência inválida...) não são erros:
 * viram transação REJECTED com failureCode, e o resultado é devolvido normalmente.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidPayloadError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different payload`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class BusinessRuleViolationError extends ApplicationError {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
