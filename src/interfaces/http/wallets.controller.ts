import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CreateWallet } from '../../application/wallets/create-wallet';
import { ReconcileWallet } from '../../application/wallets/reconcile-wallet';
import { WalletQueries } from '../../application/wallets/wallet-queries';
import { decodeCursor, encodeCursor, ledgerEntryView, parseLimit, requireMoney, requireObject, walletView } from './presenters';
import { ProviderAuthGuard } from './provider-auth.guard';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const input = requireObject(body);
    const wallet = await this.createWallet.execute({
      playerId: input.playerId as string,
      initialBalance: requireMoney(input.initialBalance, 'initialBalance'),
    });
    return walletView(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletView(await this.queries.getWallet(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const afterSeq = decodeCursor(cursor);
    const page = await this.queries.getLedger(walletId, {
      ...(afterSeq !== undefined && { afterSeq }),
      limit: parseLimit(limit),
    });
    return {
      walletId,
      entries: page.entries.map(ledgerEntryView),
      nextCursor: encodeCursor(page.nextAfterSeq),
    };
  }

  /** 200 mesmo com divergência: a resposta SINALIZA (consistent=false); não é erro do request. */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(walletId);
  }
}
