import type { MoneyProps } from '../../domain/money';
import { Money } from '../../domain/money';
import { WagerTransaction, hashOpeningPayload } from '../../domain/wagering';
import { Wallet } from '../../domain/wallet';
import { InvalidPayloadError, WalletAlreadyExistsError } from '../errors';
import { ConcurrentWriteConflictError, type TransactionalRepositories, type UnitOfWork } from '../ports/repositories';
import type { Clock, IdGenerator } from '../ports/system';
import { assertUuid, translateValidationError } from '../validation';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

/**
 * POST /wallets (seção 9).
 *
 * Numa única transação SQL:
 *   1. regra "uma wallet por player + moeda" (consulta antes de inserir);
 *   2. grava a wallet (version 1);
 *   3. se o saldo inicial > 0: transação interna OPENING + lançamento CREDIT no ledger.
 *      Assim o ledger explica o saldo desde o primeiro centavo (wallet == soma do ledger).
 *
 * Corrida: dois POSTs iguais ao mesmo tempo passam os dois pelo passo 1 ("não existe").
 * O UNIQUE (player_id, currency) barra o segundo → ConcurrentWriteConflictError →
 * tentamos de novo, e agora o passo 1 ENXERGA a wallet do primeiro → 409.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const initialBalance = this.validate(command);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run((repos) => this.create(repos, command.playerId, initialBalance));
      } catch (error) {
        if (error instanceof ConcurrentWriteConflictError && attempt < 2) continue;
        throw translateValidationError(error);
      }
    }
  }

  private async create(
    repos: TransactionalRepositories,
    playerId: string,
    initialBalance: Money,
  ): Promise<Wallet> {
    const duplicate = await repos.wallets.findByPlayerAndCurrency(playerId, initialBalance.currency);
    if (duplicate) throw new WalletAlreadyExistsError(playerId, initialBalance.currency, duplicate.id);

    const at = this.clock.now();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId,
      initialBalance,
      openingTransactionId: this.ids.next(),
      openingEntryId: this.ids.next(),
      at,
    });

    // ordem das FKs: wallet -> transação OPENING -> lançamento
    await repos.wallets.insert(wallet);
    if (openingEntry) {
      const opening = WagerTransaction.createOpening({
        id: openingEntry.transactionId,
        walletId: wallet.id,
        playerId,
        money: openingEntry.money,
        payloadHash: hashOpeningPayload({ walletId: wallet.id, playerId, money: openingEntry.money.toJSON() }),
        at,
      });
      await repos.transactions.insert(opening);
      await repos.ledger.append(openingEntry);
    }
    return wallet;
  }

  private validate(command: CreateWalletCommand): Money {
    assertUuid('playerId', command.playerId);
    if (typeof command.initialBalance !== 'object' || command.initialBalance === null) {
      throw new InvalidPayloadError('INVALID_FIELD', 'initialBalance must be { amount, currency }');
    }
    try {
      const money = Money.from(command.initialBalance);
      if (money.isNegative()) {
        throw new InvalidPayloadError('INVALID_INITIAL_BALANCE', 'initialBalance cannot be negative');
      }
      return money;
    } catch (error) {
      throw translateValidationError(error);
    }
  }
}
