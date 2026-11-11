import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidPayloadError } from '../../application/errors';
import { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { WalletQueries } from '../../application/wallets/wallet-queries';
import type { WagerPayload } from '../../domain/wagering';
import { statusForTransaction } from './error-mapping';
import { requireMoney, requireObject, transactionView } from './presenters';
import { ProviderAuthGuard } from './provider-auth.guard';
import type { RequestWithContext } from './request-context';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
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
    const result = await this.processWager.execute({
      idempotencyKey,
      payload: toWagerPayload(requireObject(body)),
      context: { correlationId: req.correlationId },
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
function toWagerPayload(body: Record<string, unknown>): WagerPayload {
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
