import { InvalidCurrencyError, InvalidMoneyAmountError } from '../domain/money';
import { InvalidWagerTransactionError } from '../domain/wagering';
import { InvalidInitialBalanceError } from '../domain/wallet';
import { InvalidPayloadError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InvalidPayloadError('INVALID_FIELD', `${field} must be a UUID`);
  }
}

/**
 * Erros de VALIDAÇÃO do domínio → InvalidPayloadError. A API/consumer só precisa
 * conhecer os erros da aplicação. Qualquer outro erro passa intacto.
 */
export function translateValidationError(error: unknown): unknown {
  if (
    error instanceof InvalidWagerTransactionError ||
    error instanceof InvalidMoneyAmountError ||
    error instanceof InvalidCurrencyError ||
    error instanceof InvalidInitialBalanceError
  ) {
    return new InvalidPayloadError(error.code, error.message);
  }
  if (error instanceof TypeError && error.message.startsWith('canonicalJson')) {
    return new InvalidPayloadError('INVALID_PAYLOAD', error.message);
  }
  return error;
}
