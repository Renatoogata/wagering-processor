import { InvalidPayloadError } from '../../application/errors';
import type { WagerPayload } from '../../domain/wagering';
import { requireObject } from '../http/presenters';
import { toWagerPayload } from '../shared/wager-payload';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/** Envelope da fila wager-transactions.fifo (seção 10), já validado. */
export interface WagerMessage {
  /** id DO PRODUTOR (estável entre reenvios). É a chave da inbox, não o MessageId da SQS. */
  messageId: string;
  idempotencyKey: string;
  occurredAt: string;
  payload: WagerPayload;
}

/**
 * Corpo da SQS → WagerMessage. Qualquer problema vira InvalidPayloadError:
 * reenviar a mesma mensagem nunca vai funcionar, então ela é PERMANENTE (DLQ).
 *
 * Por que o messageId do envelope, e não o MessageId que a SQS gera?
 * A SQS gera um MessageId novo a cada SendMessage. Se o produtor reenviar a mesma
 * mensagem (timeout do lado dele), o MessageId muda, mas o messageId do envelope não:
 * só ele identifica "a mesma mensagem" de verdade.
 */
export function parseWagerMessage(body: string | undefined): WagerMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new InvalidPayloadError('INVALID_MESSAGE', 'message body is not valid JSON');
  }

  const envelope = requireObject(json);
  if (envelope.type !== WAGER_MESSAGE_TYPE) {
    throw new InvalidPayloadError('INVALID_MESSAGE', `unsupported message type ${String(envelope.type)}`);
  }
  if (typeof envelope.messageId !== 'string' || envelope.messageId.length < 1 || envelope.messageId.length > 256) {
    throw new InvalidPayloadError('INVALID_MESSAGE', 'messageId must be a string with 1 to 256 characters');
  }
  if (typeof envelope.occurredAt !== 'string') {
    throw new InvalidPayloadError('INVALID_MESSAGE', 'occurredAt must be an ISO-8601 string');
  }

  const data = requireObject(envelope.data);
  if (typeof data.idempotencyKey !== 'string') {
    throw new InvalidPayloadError('INVALID_IDEMPOTENCY_KEY', 'data.idempotencyKey must be a string');
  }

  return {
    messageId: envelope.messageId,
    idempotencyKey: data.idempotencyKey,
    occurredAt: envelope.occurredAt,
    // whitelist: idempotencyKey e outros campos de transporte não entram no payload/hash
    payload: toWagerPayload(data),
  };
}
