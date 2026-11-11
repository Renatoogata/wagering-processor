import { InvalidPayloadError } from '../../application/errors';
import type { MoneyProps } from '../../domain/money';
import type { WagerTransaction } from '../../domain/wagering';
import type { Wallet, WalletLedgerEntry } from '../../domain/wallet';

/**
 * Domínio → JSON da API. Money sai sempre como { amount: "25.00", currency } (MoneyProps),
 * datas como ISO-8601. O domínio não sabe que existe JSON; o presenter não decide nada.
 */
export function walletView(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function ledgerEntryView(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function transactionView(tx: WagerTransaction) {
  const s = tx.toState();
  return {
    id: s.id,
    providerId: s.providerId,
    externalTransactionId: s.externalTransactionId,
    idempotencyKey: s.idempotencyKey,
    walletId: s.walletId,
    playerId: s.playerId,
    roundId: s.roundId ?? null,
    gameId: s.gameId ?? null,
    kind: s.kind,
    money: s.money.toJSON(),
    status: s.status,
    referenceExternalTransactionId: s.referenceExternalTransactionId ?? null,
    referenceTransactionId: s.referenceTransactionId ?? null,
    failureCode: s.failureCode ?? null,
    balance: s.observedBalance?.toJSON() ?? null,
    attempts: s.attempts,
    nextAttemptAt: s.nextAttemptAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    processedAt: s.processedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------- cursor opaco do ledger

/**
 * O cursor é a posição `seq` do último lançamento devolvido, embrulhada em base64url.
 *
 *  - ESTÁVEL: `seq` é uma sequência que só cresce e o ledger é append-only, então
 *    lançamentos novos aparecem no fim e nunca deslocam páginas já lidas
 *    (ao contrário de OFFSET, que "pula" ou repete itens quando entra algo novo).
 *  - OPACO: o cliente não deve montar nem interpretar o cursor; o prefixo `v1:` deixa
 *    trocar o formato no futuro sem quebrar quem guarda cursores antigos.
 */
export function encodeCursor(afterSeq: string | undefined): string | null {
  return afterSeq === undefined ? null : Buffer.from(`v1:${afterSeq}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^v1:(\d{1,19})$/.exec(decoded);
  if (!match) throw new InvalidPayloadError('INVALID_CURSOR', 'cursor is invalid');
  return match[1];
}

export function parseLimit(raw: string | undefined, fallback = 50): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new InvalidPayloadError('INVALID_LIMIT', 'limit must be a positive integer');
  return Number(raw);
}

/** Corpo precisa ser um objeto JSON (não array, não null). */
export function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidPayloadError('INVALID_BODY', 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function requireMoney(value: unknown, field: string): MoneyProps {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidPayloadError('INVALID_FIELD', `${field} must be { amount, currency }`);
  }
  const { amount, currency } = value as Record<string, unknown>;
  if (typeof amount !== 'string' || typeof currency !== 'string') {
    // amount como número (25.5) é recusado: float não representa dinheiro com exatidão
    throw new InvalidPayloadError('INVALID_FIELD', `${field}.amount and ${field}.currency must be strings`);
  }
  return { amount, currency };
}
