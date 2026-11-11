import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../src/application/ports/repositories';
import { WagerTransactionProcessed } from '../../src/domain/events';
import { InboxMessage, OutboxMessage } from '../../src/domain/messaging';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  hashWagerPayload,
} from '../../src/domain/wagering';
import type { Wallet } from '../../src/domain/wallet';
import { brl, expectWalletMatchesLedger, id, openWallet, startDatabase } from './support/database';

let orm: MikroORM;
let uow: UnitOfWork;

beforeAll(async () => {
  ({ orm, uow } = await startDatabase());
});
afterAll(async () => {
  await orm.close(true);
});

function bet(wallet: Wallet, amount = '25.00') {
  const externalTransactionId = id();
  const payload = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: { amount, currency: 'BRL' },
  };
  return WagerTransaction.create({
    ...payload,
    id: id(),
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: hashWagerPayload(payload),
    money: brl(amount),
    createdAt: new Date(),
  });
}

/** O que o caso de uso vai fazer numa BET, em versão mínima: trava, debita, grava tudo. */
async function applyBet(wallet: Wallet, amount: string, holdLockMs = 0) {
  return uow.run(async (repos) => {
    const locked = (await repos.wallets.findByIdForUpdate(wallet.id))!;
    if (holdLockMs) await Bun.sleep(holdLockMs);
    const tx = bet(locked, amount);
    await repos.transactions.insert(tx);
    const entry = locked.debit({ entryId: id(), transactionId: tx.id, money: brl(amount), at: new Date() });
    tx.markProcessed({ observedBalance: locked.balance, at: new Date() });
    await repos.wallets.update(locked);
    await repos.transactions.update(tx);
    await repos.ledger.append(entry);
    return locked.balance.amount;
  });
}

describe('persistência — ida e volta', () => {
  test('wallet aberta com saldo inicial: OPENING + ledger, e o saldo bate com o ledger', async () => {
    const wallet = await openWallet(uow, '100.00');
    const loaded = await uow.run((repos) => repos.wallets.findById(wallet.id));
    expect(loaded?.toState()).toEqual(wallet.toState());
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('100.00');
  });

  test('transação: gravada, transicionada e relida pelas três chaves de busca', async () => {
    const wallet = await openWallet(uow);
    const tx = bet(wallet);
    await uow.run(async (repos) => {
      await repos.transactions.insert(tx);
      tx.reject(FailureCode.InsufficientFunds, brl('100.00'));
      await repos.transactions.update(tx);
    });
    const [byId, byKey, byExternal] = await uow.run((repos) =>
      Promise.all([
        repos.transactions.findById(tx.id),
        repos.transactions.findByIdempotencyKey(tx.idempotencyKey),
        repos.transactions.findByProviderAndExternalId(tx.providerId, tx.externalTransactionId),
      ]),
    );
    for (const found of [byId, byKey, byExternal]) {
      expect(found?.toState()).toEqual(tx.toState());
      expect(found?.status).toBe(Status.Rejected);
    }
  });

  test('outbox: o envelope (jsonb) volta idêntico', async () => {
    const wallet = await openWallet(uow);
    const tx = bet(wallet);
    tx.markProcessed({ observedBalance: brl('75.00'), at: new Date() });
    const message = OutboxMessage.enqueue(
      WagerTransactionProcessed.from(tx, { eventId: id(), correlationId: 'corr-1', occurredAt: new Date() }),
    );
    await uow.run((repos) => repos.outbox.add(message));
    const row = await orm.em.fork().getConnection().execute(`SELECT payload FROM outbox_messages WHERE id = ?`, [message.id]);
    expect(row[0]!.payload).toEqual(message.payload);
  });

  test('inbox: grava, marca como processada e relê', async () => {
    const message = InboxMessage.receive({
      consumerName: 'wager-transactions',
      messageId: id(),
      payloadHash: 'a'.repeat(64),
      receivedAt: new Date(),
    });
    await uow.run((repos) => repos.inbox.insert(message));
    message.markProcessed(new Date());
    await uow.run((repos) => repos.inbox.update(message));
    const loaded = await uow.run((repos) => repos.inbox.find(message.consumerName, message.messageId));
    expect(loaded?.toState()).toEqual(message.toState());
  });
});

describe('atomicidade', () => {
  test('se o trabalho falha no meio, NADA é gravado (wallet, transação e ledger)', async () => {
    const wallet = await openWallet(uow, '100.00');
    const tx = bet(wallet);
    await expect(
      uow.run(async (repos) => {
        const locked = (await repos.wallets.findByIdForUpdate(wallet.id))!;
        await repos.transactions.insert(tx);
        const entry = locked.debit({ entryId: id(), transactionId: tx.id, money: brl('25.00'), at: new Date() });
        await repos.wallets.update(locked);
        await repos.ledger.append(entry);
        throw new Error('processo morreu antes do commit');
      }),
    ).rejects.toThrow('processo morreu');

    const found = await uow.run((repos) => repos.transactions.findById(tx.id));
    expect(found).toBeUndefined();
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('100.00');
  });
});

describe('o banco como última linha de defesa', () => {
  const sql = (query: string, params: unknown[] = []) => orm.em.fork().getConnection().execute(query, params);

  test('saldo negativo é recusado pelo schema', async () => {
    const wallet = await openWallet(uow, '10.00');
    await expect(sql(`UPDATE wallets SET balance = -1, version = version + 1 WHERE id = ?`, [wallet.id])).rejects.toThrow();
  });

  test('ledger é append-only: UPDATE e DELETE são recusados', async () => {
    const wallet = await openWallet(uow, '10.00');
    await expect(sql(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?`, [wallet.id])).rejects.toThrow();
    await expect(sql(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id])).rejects.toThrow();
  });

  test('idempotency key duplicada é recusada mesmo que o código esqueça de checar', async () => {
    const wallet = await openWallet(uow);
    const first = bet(wallet);
    await uow.run((repos) => repos.transactions.insert(first));
    const clone = WagerTransaction.rehydrate({ ...first.toState(), id: id(), externalTransactionId: id() });
    await expect(uow.run((repos) => repos.transactions.insert(clone))).rejects.toThrow();
  });
});

describe('lock da wallet (SELECT ... FOR UPDATE)', () => {
  test('a segunda transação espera a primeira e enxerga o saldo já debitado', async () => {
    const wallet = await openWallet(uow, '100.00');
    // A trava a wallet e segura por 300ms; B começa logo depois e precisa esperar
    const a = applyBet(wallet, '30.00', 300);
    await Bun.sleep(50);
    const b = applyBet(wallet, '20.00');
    expect(await a).toBe('70.00');
    expect(await b).toBe('50.00'); // sem o lock, B leria 100.00 e gravaria 80.00 (lost update)
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('50.00');
  });

  test('wallets diferentes não se bloqueiam (sem lock global)', async () => {
    const [w1, w2] = await Promise.all([openWallet(uow), openWallet(uow)]);
    const started = performance.now();
    await Promise.all([applyBet(w1, '10.00', 300), applyBet(w2, '10.00', 300)]);
    expect(performance.now() - started).toBeLessThan(550); // em série levaria >= 600ms
  });
});

describe('ledger — paginação por cursor', () => {
  test('páginas estáveis e sem repetição', async () => {
    const wallet = await openWallet(uow, '100.00');
    for (let i = 0; i < 4; i++) await applyBet(wallet, '1.00');

    const page1 = await uow.run((repos) => repos.ledger.listByWallet(wallet.id, { limit: 2 }));
    const page2 = await uow.run((repos) => repos.ledger.listByWallet(wallet.id, { limit: 2, afterSeq: page1.nextAfterSeq }));
    const page3 = await uow.run((repos) => repos.ledger.listByWallet(wallet.id, { limit: 2, afterSeq: page2.nextAfterSeq }));

    const versions = [...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.walletVersion);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
    expect(page3.nextAfterSeq).toBeUndefined();
  });
});
