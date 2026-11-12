import type { AppLogger, Metrics } from '../../application/ports/observability';
import type { WagerTransactionResult } from '../../application/wagering/wager-transaction-result';
import type { WagerPayload } from '../../domain/wagering';

export type Channel = 'http' | 'sqs';

/**
 * Métricas e log de uma operação processada, IGUAIS para HTTP e SQS (seção 12):
 *  - wager_transactions_total{channel,status}  → transações por status
 *  - wager_duplicates_total{channel}           → duplicatas detectadas (replay)
 *  - wager_processing_seconds{channel}         → latência de processamento
 *
 * O log leva só ids (correlationId, transactionId, walletId, providerId...) e o status,
 * NUNCA o payload financeiro completo.
 */
export function recordWagerOutcome(
  telemetry: { metrics: Metrics; logger: AppLogger },
  channel: Channel,
  payload: WagerPayload,
  result: WagerTransactionResult,
  startedAt: number,
  extra: Record<string, string | number | boolean | undefined> = {},
): void {
  const seconds = (performance.now() - startedAt) / 1000;
  telemetry.metrics.increment('wager_transactions_total', { channel, status: result.status });
  if (result.idempotentReplay) telemetry.metrics.increment('wager_duplicates_total', { channel });
  telemetry.metrics.observe('wager_processing_seconds', seconds, { channel });
  telemetry.logger.info('wager transaction processed', {
    channel,
    ...extra,
    transactionId: result.transactionId,
    walletId: payload.walletId,
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    kind: payload.kind,
    status: result.status,
    failureCode: result.failureCode,
    idempotentReplay: result.idempotentReplay,
    durationMs: Math.round(seconds * 1000),
  });
}
