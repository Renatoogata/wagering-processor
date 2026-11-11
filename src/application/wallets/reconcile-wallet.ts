import type { MoneyProps } from '../../domain/money';
import { WalletNotFoundError } from '../errors';
import type { AppLogger, Metrics } from '../ports/observability';
import type { UnitOfWork } from '../ports/repositories';
import { assertUuid } from '../validation';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** stored - calculated: positivo = a wallet tem MAIS do que o ledger explica */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * POST /wallets/:id/reconciliation (seção 9).
 *
 * Compara o saldo GRAVADO na wallet com o saldo RECONSTRUÍDO pelo ledger.
 *
 * Por que travar a wallet (FOR UPDATE) se é só leitura?
 * Em READ COMMITTED cada SELECT enxerga o que estava commitado no momento EM QUE ELE roda.
 * Sem o lock, um BET poderia commitar entre "ler a wallet" e "somar o ledger": a soma
 * incluiria um débito que o saldo lido ainda não tinha → falsa divergência.
 * Com o lock, ninguém muda a wallet (nem o ledger dela) até terminarmos.
 *
 * Divergência NÃO é corrigida aqui (seção 9): logamos, contamos na métrica e devolvemos
 * `consistent: false`. Corrigir saldo automaticamente esconderia o bug que causou a diferença.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    assertUuid('walletId', walletId);

    const result = await this.uow.run(async (repos) => {
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const { balance: calculated, entries } = await repos.ledger.calculateBalance(walletId, wallet.currency);
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: entries,
      };
    });

    this.metrics.increment('wallet_reconciliations_total', { result: result.consistent ? 'consistent' : 'divergent' });
    if (!result.consistent) {
      this.logger.error('wallet reconciliation divergence', {
        walletId,
        stored: result.storedBalance.amount,
        calculated: result.calculatedBalance.amount,
        difference: result.difference.amount,
        currency: result.storedBalance.currency,
      });
    }
    return result;
  }
}
