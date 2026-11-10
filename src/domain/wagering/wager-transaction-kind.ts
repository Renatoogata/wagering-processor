export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/**
 * Ciclo de vida:
 *
 *   PENDING ──┬──► PROCESSED            (aplicada)
 *             ├──► REJECTED             (regra de negócio violada)
 *             ├──► FAILED               (erro permanente de infraestrutura)
 *             └──► PENDING_REFERENCE ──┬──► PENDING_REFERENCE (nova tentativa)
 *                                      ├──► PROCESSED
 *                                      ├──► REJECTED (ex.: referência nunca chegou)
 *                                      └──► FAILED
 *
 * PROCESSED, REJECTED e FAILED são terminais: não saem mais desse estado.
 */
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Kinds que podem chegar pela API ou pela fila (OPENING é interno). */
export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];
