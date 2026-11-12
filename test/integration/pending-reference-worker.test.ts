import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InMemoryMetrics, type AppLogger } from '../../src/application/ports/observability';
import type { UnitOfWork } from '../../src/application/ports/repositories';
import { uuidV7Generator, type Clock } from '../../src/application/ports/system';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { ResolveDuePendingReferences } from '../../src/application/wagering/resolve-due-pending-references';
import {
  FailureCode,
  ReferenceRetryPolicy,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wagering';
import type { Wallet } from '../../src/domain/wallet';
import { expectWalletMatchesLedger, id, openWallet, startDatabase } from './support/database';

/**
 * Worker de PENDING_REFERENCE (seção 7.1) contra Postgres REAL.
 * Concorrência 7: "ROLLBACK ou REFUND entregue antes da referência".
 *
 * O relógio é controlado pelo teste: o backoff (1s, 2s, 4s...) é avançado na mão,
 * sem sleeps; o teste é rápido e determinístico.
 */
setDefaultTimeout(30_000);

let orm: MikroORM;
let uow: UnitOfWork;
let now: number;
const clock: Clock = { now: () => new Date(now) };
const advance = (ms: number) => (now += ms);

let useCase: ProcessWagerTransaction;
const silent: AppLogger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  ({ orm, uow } = await startDatabase());
  now = Date.now();
  // limite pequeno para o teste: 1s, 2s, 4s e desiste na 4ª tentativa
  useCase = new ProcessWagerTransaction(uow, clock, uuidV7Generator, new ReferenceRetryPolicy({ baseDelayMs: 1_000, maxAttempts: 3 }));
  // pendentes deixadas por outras suítes não interessam aqui: empurra para longe
  await sql(`UPDATE wager_transactions SET next_attempt_at = now() + interval '100 years' WHERE status = 'PENDING_REFERENCE'`);
});
afterAll(async () => {
  await orm.close(true);
});

// --------------------------------------------------------------- helpers

function sql<T = Record<string, unknown>[]>(query: string, params: unknown[] = []): Promise<T> {
  return orm.em.fork().getConnection().execute(query, params) as Promise<T>;
}

function worker() {
  return new ResolveDuePendingReferences(uow, useCase, clock, silent, new InMemoryMetrics());
}

/** Envia uma operação. `ext` permite escolher o externalTransactionId (para ser referenciado depois). */
function send(wallet: Wallet, kind: Kind, amount: string, opts: { ext?: string; reference?: string } = {}) {
  const ext = opts.ext ?? id();
  return useCase.execute({
    idempotencyKey: `provider-a:${ext}`,
    payload: {
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...(opts.reference && { referenceExternalTransactionId: opts.reference }),
    },
    context: { correlationId: id() },
  });
}

const load = (transactionId: string) => uow.run((repos) => repos.transactions.findById(transactionId));

async function eventTypes(aggregateId: string): Promise<string[]> {
  const rows = await sql<{ event_type: string }[]>(
    `SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY seq`,
    [aggregateId],
  );
  return rows.map((r) => r.event_type);
}

async function credits(walletId: string, transactionId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>(
    `SELECT count(*) AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND transaction_id = ?`,
    [walletId, transactionId],
  );
  return Number(rows[0]!.n);
}

const balance = async (walletId: string) => (await expectWalletMatchesLedger(uow, walletId)).toJSON().amount;

// =============================================================== testes

describe('worker de PENDING_REFERENCE', () => {
  test('concorrência 7: REFUND chega antes da BET → espera; a BET chega; o worker aplica o REFUND', async () => {
    const wallet = await openWallet(uow, '100.00');
    const betExt = id();

    // 1. o REFUND chega primeiro: a BET ainda não existe
    const refund = await send(wallet, Kind.Refund, '30.00', { reference: betExt });
    expect(refund.status).toBe(Status.PendingReference);
    expect(await balance(wallet.id)).toBe('100.00');

    // 2. a BET chega depois
    expect((await send(wallet, Kind.Bet, '30.00', { ext: betExt })).status).toBe(Status.Processed);
    expect(await balance(wallet.id)).toBe('70.00');

    // 3. antes do backoff vencer, o worker não mexe
    expect(await worker().execute()).toBe(0);
    expect((await load(refund.transactionId))!.status).toBe(Status.PendingReference);

    // 4. venceu: o worker encontra a BET e aplica o REFUND
    advance(1_500);
    expect(await worker().execute()).toBe(1);
    const resolved = (await load(refund.transactionId))!;
    expect(resolved.status).toBe(Status.Processed);
    expect(resolved.referenceTransactionId).toBeDefined();
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await eventTypes(refund.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed']);
  });

  test('ROLLBACK de um WIN que chega antes → quando o WIN chega, o worker DEBITA', async () => {
    const wallet = await openWallet(uow, '100.00');
    const winExt = id();

    const rollback = await send(wallet, Kind.Rollback, '20.00', { reference: winExt });
    expect(rollback.status).toBe(Status.PendingReference);
    await send(wallet, Kind.Win, '20.00', { ext: winExt });
    expect(await balance(wallet.id)).toBe('120.00');

    advance(1_500);
    await worker().execute();
    expect((await load(rollback.transactionId))!.status).toBe(Status.Processed);
    expect(await balance(wallet.id)).toBe('100.00');
  });

  test('a referência NUNCA chega → no limite de tentativas, REJECTED REFERENCE_NOT_FOUND + evento', async () => {
    const wallet = await openWallet(uow, '100.00');
    const refund = await send(wallet, Kind.Refund, '30.00', { reference: id() });

    const attempts: number[] = [];
    for (let i = 0; i < 6; i++) {
      advance(60_000);
      await worker().execute();
      const tx = (await load(refund.transactionId))!;
      attempts.push(tx.attempts);
      if (tx.status !== Status.PendingReference) break;
    }

    const final = (await load(refund.transactionId))!;
    expect(final.status).toBe(Status.Rejected);
    expect(final.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(attempts).toEqual([2, 3, 3]); // 2 novas tentativas e depois desiste
    expect(await eventTypes(refund.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await balance(wallet.id)).toBe('100.00');
  });

  test('a referência chega mas é inválida (REFUND de um WIN) → REJECTED com o código da regra', async () => {
    const wallet = await openWallet(uow, '100.00');
    const winExt = id();
    const refund = await send(wallet, Kind.Refund, '20.00', { reference: winExt });
    await send(wallet, Kind.Win, '20.00', { ext: winExt });

    advance(1_500);
    await worker().execute();
    const final = (await load(refund.transactionId))!;
    expect(final.status).toBe(Status.Rejected);
    expect(final.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect(await balance(wallet.id)).toBe('120.00');
  });

  test('três workers ao mesmo tempo na mesma pendente → o REFUND é aplicado uma única vez', async () => {
    const wallet = await openWallet(uow, '100.00');
    const betExt = id();
    const refund = await send(wallet, Kind.Refund, '30.00', { reference: betExt });
    await send(wallet, Kind.Bet, '30.00', { ext: betExt });

    advance(1_500);
    const handled = await Promise.all([worker().execute(), worker().execute(), worker().execute()]);

    expect(handled.reduce((a, b) => a + b, 0)).toBe(1); // só um aplicou; os outros releram e pularam
    expect(await credits(wallet.id, refund.transactionId)).toBe(1);
    expect(await balance(wallet.id)).toBe('100.00');
  });
});
