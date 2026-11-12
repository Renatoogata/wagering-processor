import type { AppLogger, Metrics } from '../ports/observability';
import type { UnitOfWork } from '../ports/repositories';
import type { Clock } from '../ports/system';
import type { ProcessWagerTransaction } from './process-wager-transaction';

/**
 * Uma rodada do worker de PENDING_REFERENCE (seção 7.1).
 *
 * 1. lista as pendentes cuja tentativa venceu (leitura simples, sem lock);
 * 2. resolve cada uma na SUA transação (lock da wallet → relê → decide → commit).
 *
 * Várias instâncias podem listar a mesma pendente. Não tem problema: o lock da wallet
 * coloca as duas em fila, e a segunda relê a transação já resolvida e não faz nada.
 * Uma transação por item (e não uma para o lote todo) para não segurar o lock de
 * várias wallets ao mesmo tempo e para um item com erro não desfazer os outros.
 *
 * Devolve quantas foram efetivamente tratadas (0 = nada a fazer → o worker dorme).
 * Itens com erro NÃO contam: se contassem, um erro persistente faria o worker girar sem parar.
 */
export class ResolveDuePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processWager: Pick<ProcessWagerTransaction, 'resolvePendingReference'>,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly batchSize = 20,
  ) {}

  async execute(): Promise<number> {
    const due = await this.uow.run((repos) => repos.transactions.findDuePendingReferences(this.clock.now(), this.batchSize));

    let handled = 0;
    for (const { id, walletId } of due) {
      try {
        const result = await this.processWager.resolvePendingReference(id, walletId);
        if (!result) continue; // outra instância resolveu, ou ainda não venceu
        handled++;
        this.metrics.increment('pending_reference_attempts_total', { status: result.status });
        this.logger.info('pending reference attempt', {
          transactionId: id,
          walletId,
          status: result.status,
          failureCode: result.failureCode,
        });
      } catch (error) {
        this.metrics.increment('pending_reference_errors_total');
        this.logger.error('pending reference attempt failed', {
          transactionId: id,
          walletId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }
    return handled;
  }
}
