import { InvalidPayloadError } from '../../application/errors';
import type { WagerPayload } from '../../domain/wagering';
import { requireMoney } from '../http/presenters';

/**
 * Parse do payload de negócio, IGUAL para HTTP e SQS (seção 10: mesmo use case,
 * mesma validação). Se cada entrada validasse do seu jeito, a mesma operação poderia
 * ser aceita por um canal e recusada pelo outro.
 */
const STRING_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'referenceExternalTransactionId',
] as const;

/**
 * Copia SÓ os campos de negócio do corpo (whitelist). Campos extras são ignorados
 * e não entram no hash. Tipo errado (ex.: número no lugar de string) → 400 aqui mesmo;
 * regras de conteúdo (kind válido, referência obrigatória...) ficam no domínio.
 */
export function toWagerPayload(body: Record<string, unknown>): WagerPayload {
  const payload: Record<string, unknown> = {};
  for (const field of STRING_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new InvalidPayloadError('INVALID_FIELD', `${field} must be a string`);
    payload[field] = value;
  }
  payload.money = requireMoney(body.money, 'money');
  return payload as unknown as WagerPayload;
}
