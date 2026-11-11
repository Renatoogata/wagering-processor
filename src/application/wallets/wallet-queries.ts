import type { WagerTransaction } from '../../domain/wagering';
import type { Wallet } from '../../domain/wallet';
import { InvalidPayloadError, TransactionNotFoundError, WalletNotFoundError } from '../errors';
import type { LedgerPage, UnitOfWork } from '../ports/repositories';
import { assertUuid } from '../validation';

export const MAX_LEDGER_PAGE = 200;

/**
 * Consultas (seção 9). Só leitura, sem lock: devolvem o último estado COMMITADO.
 * Um id que não é UUID nunca vai existir, então é payload inválido (400), não 404.
 */
export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<Wallet> {
    assertUuid('walletId', walletId);
    const wallet = await this.uow.run((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  /** `afterSeq` é a posição interna; quem a torna "opaca" para o cliente é a camada HTTP. */
  async getLedger(walletId: string, options: { afterSeq?: string; limit: number }): Promise<LedgerPage> {
    assertUuid('walletId', walletId);
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_LEDGER_PAGE) {
      throw new InvalidPayloadError('INVALID_LIMIT', `limit must be an integer between 1 and ${MAX_LEDGER_PAGE}`);
    }
    return this.uow.run(async (repos) => {
      if (!(await repos.wallets.findById(walletId))) throw new WalletNotFoundError(walletId);
      return repos.ledger.listByWallet(walletId, options);
    });
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    assertUuid('transactionId', transactionId);
    const tx = await this.uow.run((repos) => repos.transactions.findById(transactionId));
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return tx;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.run((repos) =>
      repos.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
    if (!tx) throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    return tx;
  }
}
