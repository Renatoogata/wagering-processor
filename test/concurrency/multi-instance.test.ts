import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../src/application/ports/repositories';
import { expectWalletMatchesLedger, id, startDatabase } from '../integration/support/database';
import { createTestQueues, queueDepth, sendRaw, sqsClient, waitFor, type TestQueues } from '../integration/support/sqs';
import { scrapeCounter, startInstance, type Instance, type InstanceQueues } from './support/instances';

/**
 * Seção 13, concorrência com PROCESSOS REAIS (nada de mocks, nada de memória compartilhada):
 *   4. ≥ 3 processos/instâncias simultâneos
 *   5. worker morto (aqui: SIGKILL no processo inteiro) e outra instância assume
 *   8. reinício do serviço com comprovação da consistência final
 * Invariante em todos: wallet.balance == saldo reconstruído pelo ledger.
 *
 * Cada suíte usa filas próprias (visibility timeout curto, para o crash não custar 30s).
 */
setDefaultTimeout(120_000);

let orm: MikroORM;
let uow: UnitOfWork;
let sqs: SQSClient;
let wagerQueues: TestQueues;
let eventQueues: TestQueues;
let queues: InstanceQueues;
const running: Instance[] = [];

beforeAll(async () => {
  ({ orm, uow } = await startDatabase());
  sqs = sqsClient();
  wagerQueues = await createTestQueues(sqs, 'mi-wager', 10, 5);
  eventQueues = await createTestQueues(sqs, 'mi-events');
  queues = { wagerQueueUrl: wagerQueues.queueUrl, wagerDlqUrl: wagerQueues.dlqUrl, eventsQueueUrl: eventQueues.queueUrl };
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.kill()));
});
afterAll(async () => {
  await wagerQueues.destroy();
  await eventQueues.destroy();
  sqs.destroy();
  await orm.close(true);
});

// --------------------------------------------------------------- helpers

async function start(name: string): Promise<Instance> {
  const instance = await startInstance(name, queues);
  running.push(instance);
  return instance;
}

function sql<T = Record<string, unknown>[]>(query: string, params: unknown[] = []): Promise<T> {
  return orm.em.fork().getConnection().execute(query, params) as Promise<T>;
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

interface TestWallet {
  walletId: string;
  playerId: string;
}

async function createWallet(instance: Instance, amount: string): Promise<TestWallet> {
  const playerId = id();
  const res = await post(instance.baseUrl, '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id, playerId };
}

function betData(w: TestWallet, amount: string, externalTransactionId = id()) {
  return {
    providerId: 'provider-mi',
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

function betViaHttp(instance: Instance, data: ReturnType<typeof betData>) {
  return post(instance.baseUrl, '/wagering/transactions', data, {
    'idempotency-key': `${data.providerId}:${data.externalTransactionId}`,
  });
}

async function betViaSqs(data: ReturnType<typeof betData>): Promise<void> {
  const envelope = {
    messageId: `msg-${data.externalTransactionId}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
  };
  // MessageGroupId = walletId: ordem por wallet, wallets diferentes em paralelo
  await sendRaw(sqs, wagerQueues.queueUrl, JSON.stringify(envelope), data.walletId);
}

/** Linhas gravadas por externalTransactionId (deve ser EXATAMENTE 1 para cada). */
async function rowsPerExternalId(externalIds: string[]): Promise<Map<string, { status: string }[]>> {
  const rows = await sql<{ external_transaction_id: string; status: string }[]>(
    `SELECT external_transaction_id, status FROM wager_transactions
      WHERE provider_id = 'provider-mi' AND external_transaction_id IN (?)`,
    [externalIds],
  );
  const map = new Map<string, { status: string }[]>();
  for (const r of rows) map.set(r.external_transaction_id, [...(map.get(r.external_transaction_id) ?? []), { status: r.status }]);
  return map;
}

async function balance(walletId: string): Promise<string> {
  return (await expectWalletMatchesLedger(uow, walletId)).toJSON().amount;
}

async function unpublishedEventsFor(walletIds: string[]): Promise<number> {
  const [row] = await sql<{ n: string }[]>(
    `SELECT count(*) AS n FROM outbox_messages o
      WHERE o.published_at IS NULL
        AND (o.aggregate_id IN (?)
             OR o.aggregate_id IN (SELECT id::text FROM wager_transactions WHERE wallet_id IN (?)))`,
    [walletIds, walletIds],
  );
  return Number(row!.n);
}

// =============================================================== testes

describe('três instâncias reais da aplicação', () => {
  test('concorrência 4: hot wallet disputada por 3 processos via HTTP e SQS → saldo nunca negativo, nada duplicado', async () => {
    const instances = await Promise.all([start('a'), start('b'), start('c')]);
    const hot = await createWallet(instances[0]!, '100.00');
    const others = await Promise.all(Array.from({ length: 5 }, () => createWallet(instances[1]!, '50.00')));

    // 20 BETs de 10.00 por HTTP, cada uma enviada DUAS vezes a instâncias DIFERENTES ao mesmo tempo
    const httpBets = Array.from({ length: 20 }, () => betData(hot, '10.00'));
    // + 20 BETs de 10.00 por SQS na mesma wallet (consumidas pelas 3 instâncias)
    const sqsBets = Array.from({ length: 20 }, () => betData(hot, '10.00'));
    // + 5 wallets independentes com 5 BETs cada (não podem se bloquear: lock por wallet, não global)
    const otherBets = others.flatMap((w) => Array.from({ length: 5 }, () => betData(w, '10.00')));

    await Promise.all([...sqsBets, ...otherBets].map(betViaSqs));
    const httpResponses = await Promise.all(
      httpBets.flatMap((data, i) => [betViaHttp(instances[i % 3]!, data), betViaHttp(instances[(i + 1) % 3]!, data)]),
    );

    const allExternalIds = [...httpBets, ...sqsBets, ...otherBets].map((b) => b.externalTransactionId);
    await waitFor(
      'todas as operações gravadas e a fila vazia',
      async () =>
        (await rowsPerExternalId(allExternalIds)).size === allExternalIds.length &&
        (await queueDepth(sqs, wagerQueues.queueUrl)) === 0,
      60_000,
      500,
    );

    // cada operação gravada UMA vez, mesmo enviada 2x a instâncias diferentes
    const rows = await rowsPerExternalId(allExternalIds);
    for (const externalId of allExternalIds) expect(rows.get(externalId)).toHaveLength(1);
    for (let i = 0; i < httpBets.length; i++) {
      const [first, second] = [httpResponses[2 * i]!, httpResponses[2 * i + 1]!];
      expect([200, 422]).toContain(first.status);
      expect(second.body.transactionId).toBe(first.body.transactionId); // a outra cópia virou replay
    }

    // hot wallet: 40 apostas distintas de 10.00 sobre 100.00 → exatamente 10 aplicadas
    const hotStatuses = [...httpBets, ...sqsBets].map((b) => rows.get(b.externalTransactionId)![0]!.status);
    expect(hotStatuses.filter((s) => s === 'PROCESSED')).toHaveLength(10);
    expect(hotStatuses.filter((s) => s === 'REJECTED')).toHaveLength(30);
    expect(await balance(hot.walletId)).toBe('0.00');

    // wallets independentes: todas as 5 apostas aplicadas
    for (const w of others) expect(await balance(w.walletId)).toBe('0.00');

    // as mensagens da SQS foram de fato divididas entre os processos
    const sqsPerInstance = await Promise.all(
      instances.map((i) => scrapeCounter(i.baseUrl, 'wager_transactions_total', 'channel="sqs"')),
    );
    expect(sqsPerInstance.reduce((a, b) => a + b, 0)).toBe(sqsBets.length + otherBets.length);
    expect(sqsPerInstance.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);

    // e os eventos de tudo isso foram publicados pelos relays das 3 instâncias
    await waitFor('outbox escoada', async () => (await unpublishedEventsFor([hot.walletId, ...others.map((w) => w.walletId)])) === 0, 30_000, 500);
  });

  test('concorrência 5 e 8: SIGKILL numa instância no meio do trabalho, SIGTERM em outra, reinício → tudo processado uma vez e consistente', async () => {
    const [a, b, c] = await Promise.all([start('a'), start('b'), start('c')]);
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(a, '1000.00')));
    const bets = wallets.flatMap((w) => Array.from({ length: 10 }, () => betData(w, '10.00')));
    await Promise.all(bets.map(betViaSqs));

    // espera o trabalho começar e derruba "a" sem aviso: mensagens em voo ficam sem ack
    await waitFor('processamento começou', async () => (await rowsPerExternalId(bets.map((x) => x.externalTransactionId))).size > 0, 30_000, 50);
    await a.kill();
    const doneAtKill = (await rowsPerExternalId(bets.map((x) => x.externalTransactionId))).size;
    // o kill tem que pegar trabalho pela metade, senão o teste não provaria nada
    expect(doneAtKill).toBeLessThan(bets.length);
    // "b" recebe SIGTERM: termina o que está em andamento e devolve o resto à fila
    await b.terminate();
    // uma instância nova sobe (o "reinício"), junto com "c" que nunca parou
    const d = await start('d');

    await waitFor(
      'todas as 60 apostas gravadas e a fila vazia',
      async () =>
        (await rowsPerExternalId(bets.map((x) => x.externalTransactionId))).size === bets.length &&
        (await queueDepth(sqs, wagerQueues.queueUrl)) === 0,
      90_000,
      500,
    );

    // nada perdido, nada duplicado
    const rows = await rowsPerExternalId(bets.map((x) => x.externalTransactionId));
    for (const bet of bets) {
      expect(rows.get(bet.externalTransactionId)).toHaveLength(1);
      expect(rows.get(bet.externalTransactionId)![0]!.status).toBe('PROCESSED');
    }
    for (const w of wallets) expect(await balance(w.walletId)).toBe('900.00');
    await waitFor('outbox escoada', async () => (await unpublishedEventsFor(wallets.map((w) => w.walletId))) === 0, 30_000, 500);

    // reinício completo: tudo para, uma instância nova sobe e a reconciliação confirma
    await Promise.all([c.terminate(), d.terminate()]);
    const fresh = await start('fresh');
    for (const w of wallets) {
      const rec = await post(fresh.baseUrl, `/wallets/${w.walletId}/reconciliation`, {});
      expect(rec.body.consistent).toBe(true);
    }
  });
});
