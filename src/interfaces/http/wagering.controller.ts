import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidPayloadError } from '../../application/errors';
import { APP_LOGGER, METRICS, type AppLogger, type Metrics } from '../../application/ports/observability';
import { recordWagerOutcome } from '../shared/wager-telemetry';
import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { WalletQueries } from '../../application/wallets/wallet-queries';
import { statusForTransaction } from './error-mapping';
import { toWagerPayload } from '../shared/wager-payload';
import { requireObject, transactionView } from './presenters';
import { ProviderAuthGuard } from './provider-auth.guard';
import type { RequestWithContext } from './request-context';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  /**
   * Submete uma operação do provedor. Status da resposta = estado da transação
   * (200 PROCESSED, 202 PENDING_REFERENCE, 422 REJECTED), igual num replay.
   */
  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() req: RequestWithContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new InvalidPayloadError('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
    }
    const started = performance.now();
    const payload = toWagerPayload(requireObject(body));
    const result = await this.processWager.execute({
      idempotencyKey,
      payload,
      context: { correlationId: req.correlationId },
    });
    recordWagerOutcome({ metrics: this.metrics, logger: this.logger }, 'http', payload, result, started, {
      correlationId: req.correlationId,
    });
    res.status(statusForTransaction(result.status));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    return transactionView(await this.queries.getTransaction(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return transactionView(await this.queries.getTransactionByExternalId(providerId, externalTransactionId));
  }
}
