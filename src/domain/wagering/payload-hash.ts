import { createHash } from 'node:crypto';
import type { MoneyProps } from '../money';
import { canonicalJson } from '../shared/canonical-json';
import { WagerTransactionKind } from './wager-transaction-kind';

/**
 * Os campos de NEGÓCIO de uma operação: o que define "qual operação é esta".
 *
 * Ficam DE FORA (metadados de transporte):
 *  - o header/campo `idempotencyKey` — ele é a chave de busca, não o conteúdo;
 *  - `messageId`, `occurredAt`, headers HTTP, correlationId.
 *
 * Consequência importante: a mesma operação enviada por HTTP e por SQS gera
 * o MESMO hash. Se o provedor mandar a BET pelos dois canais, o segundo é replay.
 */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = SHA-256, em hexadecimal minúsculo, do JSON canônico do WagerPayload.
 *
 * Os campos são copiados UM A UM (whitelist): se o objeto de entrada tiver campos
 * extras (ex.: o DTO inteiro da SQS com `idempotencyKey`), eles não entram no hash.
 * Adicionar um campo aqui muda todos os hashes — é uma mudança de contrato.
 */
export function hashWagerPayload(p: WagerPayload): string {
  return sha256Hex(
    canonicalJson({
      providerId: p.providerId,
      externalTransactionId: p.externalTransactionId,
      playerId: p.playerId,
      walletId: p.walletId,
      roundId: p.roundId,
      gameId: p.gameId,
      kind: p.kind,
      money: { amount: p.money.amount, currency: p.money.currency },
      referenceExternalTransactionId: p.referenceExternalTransactionId,
    }),
  );
}

/** Hash da transação interna OPENING (não vem de provedor, mas a coluna é NOT NULL). */
export function hashOpeningPayload(p: { walletId: string; playerId: string; money: MoneyProps }): string {
  return sha256Hex(
    canonicalJson({
      kind: WagerTransactionKind.Opening,
      walletId: p.walletId,
      playerId: p.playerId,
      money: { amount: p.money.amount, currency: p.money.currency },
    }),
  );
}

/**
 * Conteúdo de uma mensagem da inbox = "qual key" + "qual operação".
 * A inbox guarda este hash para detectar o mesmo messageId chegando com conteúdo
 * diferente (inclusive com a MESMA operação, mas outra idempotency key).
 */
export function hashInboxContent(idempotencyKey: string, payloadHash: string): string {
  return sha256Hex(canonicalJson({ idempotencyKey, payloadHash }));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
