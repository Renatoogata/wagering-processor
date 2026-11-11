import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../../mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-repositories';
import { Money } from '../../../src/domain/money';
import { WagerTransaction, hashOpeningPayload } from '../../../src/domain/wagering';
import { Wallet } from '../../../src/domain/wallet';
import type { UnitOfWork } from '../../../src/application/ports/repositories';

/**
 * Testes de integração usam o Postgres REAL do docker compose (porta 55432).
 * Cada teste cria seus próprios ids (UUID aleatório), então não há limpeza entre
 * testes nem interferência entre execuções — inclusive em paralelo.
 */
export async function startDatabase(): Promise<{ orm: MikroORM; uow: UnitOfWork }> {
  const orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.up();
  return { orm, uow: new MikroOrmUnitOfWork(orm.em) };
}

export const id = () => crypto.randomUUID();
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

/** Abre uma wallet com saldo inicial, do jeito que o caso de uso CreateWallet vai fazer. */
export async function openWallet(uow: UnitOfWork, initialBalance = '100.00'): Promise<Wallet> {
  const at = new Date();
  const playerId = id();
  const { wallet, openingEntry } = Wallet.open({
    id: id(),
    playerId,
    initialBalance: brl(initialBalance),
    openingTransactionId: id(),
    openingEntryId: id(),
    at,
  });
  await uow.run(async (repos) => {
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
  });
  return wallet;
}

/**
 * INVARIANTE FINAL de todos os testes (seção 13):
 *   wallet.balance == saldo reconstruído pelo ledger
 */
export async function expectWalletMatchesLedger(uow: UnitOfWork, walletId: string): Promise<Money> {
  return uow.run(async (repos) => {
    const wallet = await repos.wallets.findById(walletId);
    expect(wallet).toBeDefined();
    const { balance } = await repos.ledger.calculateBalance(walletId, wallet!.currency);
    expect(balance.toJSON()).toEqual(wallet!.balance.toJSON());
    return wallet!.balance;
  });
}
