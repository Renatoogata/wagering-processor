import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { METRICS, type InMemoryMetrics } from '../../src/application/ports/observability';
import { api, startApp, type TestApp } from './support/app';

let app: TestApp;
let http: ReturnType<typeof api>;

beforeAll(async () => {
  app = await startApp();
  http = api(app.baseUrl);
});
afterAll(() => app.close());

const id = () => crypto.randomUUID();
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(amount = '100.00', playerId = id()) {
  const res = await http.post('/wallets', { playerId, initialBalance: brl(amount) });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

function wager(w: { walletId: string; playerId: string }, over: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-e2e',
    externalTransactionId: id(),
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('25.00'),
    ...over,
  };
}

function submit(body: Record<string, unknown>, key = `${body.providerId}:${body.externalTransactionId}`) {
  return http.post('/wagering/transactions', body, { 'idempotency-key': key });
}

describe('POST /wallets', () => {
  test('201 com o formato da seção 9; saldo inicial gera OPENING + CREDIT no ledger', async () => {
    const playerId = id();
    const res = await http.post('/wallets', { playerId, initialBalance: brl('1000.00') });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });

    const ledger = await http.get(`/wallets/${res.body.id}/ledger`);
    expect(ledger.body.entries).toHaveLength(1);
    expect(ledger.body.entries[0]).toMatchObject({ direction: 'CREDIT', money: brl('1000.00'), walletVersion: 1 });

    const opening = await http.get(`/wagering/transactions/${ledger.body.entries[0].transactionId}`);
    expect(opening.body).toMatchObject({ kind: 'OPENING', status: 'PROCESSED' });
  });

  test('saldo inicial zero: wallet sem lançamentos, e ainda assim consistente', async () => {
    const { walletId } = await createWallet('0.00');
    expect((await http.get(`/wallets/${walletId}/ledger`)).body.entries).toEqual([]);
    const rec = await http.post(`/wallets/${walletId}/reconciliation`);
    expect(rec.body).toMatchObject({ consistent: true, checkedEntries: 0 });
  });

  test('mesmo player + moeda: 409, inclusive com 5 pedidos simultâneos (exatamente 1 cria)', async () => {
    const playerId = id();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => http.post('/wallets', { playerId, initialBalance: brl('10.00') })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([
    ['amount como número', { playerId: id(), initialBalance: { amount: 10, currency: 'BRL' } }],
    ['saldo negativo', { playerId: id(), initialBalance: brl('-1.00') }],
    ['playerId não-UUID', { playerId: 'abc', initialBalance: brl('1.00') }],
    ['casas decimais erradas', { playerId: id(), initialBalance: brl('1.5') }],
    ['corpo não é objeto', [1, 2]],
  ])('400 para %s', async (_name, body) => {
    const res = await http.post('/wallets', body);
    expect(res.status).toBe(400);
    expect(res.body.error.retryable).toBe(false);
  });
});

describe('consultas', () => {
  test('GET /wallets/:id — 200, 404 se não existe, 400 se não é UUID', async () => {
    const { walletId } = await createWallet('42.00');
    expect((await http.get(`/wallets/${walletId}`)).body.balance).toEqual(brl('42.00'));
    expect((await http.get(`/wallets/${id()}`)).status).toBe(404);
    expect((await http.get('/wallets/nao-e-uuid')).status).toBe(400);
  });

  test('transação por id e por (provider, externalId)', async () => {
    const w = await createWallet();
    const body = wager(w);
    const { body: result } = await submit(body);

    const byId = await http.get(`/wagering/transactions/${result.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: result.transactionId, status: 'PROCESSED', balance: brl('75.00') });

    const byExt = await http.get(`/providers/provider-e2e/wagering/transactions/${body.externalTransactionId}`);
    expect(byExt.body.id).toBe(result.transactionId);
    expect((await http.get(`/providers/provider-e2e/wagering/transactions/${id()}`)).status).toBe(404);
  });

  test('ledger: paginação por cursor percorre tudo, em ordem, sem repetir', async () => {
    const w = await createWallet('1.00');
    for (let i = 0; i < 5; i++) await submit(wager(w, { kind: 'WIN', money: brl('1.00') }));

    const versions: number[] = [];
    let cursor: string | null = '';
    let pages = 0;
    while (cursor !== null) {
      const res = await http.get(`/wallets/${w.walletId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      versions.push(...res.body.entries.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = res.body.nextCursor;
      pages++;
    }
    expect(versions).toEqual([1, 2, 3, 4, 5, 6]); // abertura + 5 WINs
    expect(pages).toBe(3);
  });

  test('ledger: cursor adulterado e limit fora do intervalo → 400', async () => {
    const { walletId } = await createWallet();
    expect((await http.get(`/wallets/${walletId}/ledger?cursor=lixo`)).body.error.code).toBe('INVALID_CURSOR');
    expect((await http.get(`/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await http.get(`/wallets/${walletId}/ledger?limit=1000`)).status).toBe(400);
  });
});

describe('POST /wagering/transactions — mapeamento de status', () => {
  test('200 PROCESSED; reenvio idêntico = 200 replay com o MESMO corpo', async () => {
    const w = await createWallet();
    const body = wager(w);
    const first = await submit(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: brl('75.00'), idempotentReplay: false });

    const again = await submit(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('409 mesma key com payload diferente (não é replay)', async () => {
    const w = await createWallet();
    const body = wager(w);
    await submit(body);
    const res = await submit({ ...body, money: brl('26.00') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('409 mesmo (provider, externalId) com OUTRA key', async () => {
    const w = await createWallet();
    const body = wager(w);
    await submit(body);
    const res = await submit(body, 'outra-key');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_EXTERNAL_TRANSACTION');
  });

  test('422 REJECTED (gravada): tem transactionId, failureCode e saldo observado', async () => {
    const w = await createWallet('10.00');
    const res = await submit(wager(w));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
    });
  });

  test('422 violação de regra NÃO gravável (moeda diferente): corpo de erro, sem transactionId', async () => {
    const w = await createWallet();
    const res = await submit(wager(w, { money: { amount: '1.00', currency: 'USD' } }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CURRENCY_MISMATCH');
  });

  test('202 PENDING_REFERENCE quando a referência ainda não chegou', async () => {
    const w = await createWallet();
    const res = await submit(wager(w, { kind: 'REFUND', referenceExternalTransactionId: id() }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test('404 wallet inexistente; 400 sem Idempotency-Key, JSON malformado ou tipo errado', async () => {
    const w = await createWallet();
    expect((await submit(wager({ ...w, walletId: id() }))).status).toBe(404);

    const noKey = await http.post('/wagering/transactions', wager(w));
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');

    const badJson = await http.post('/wagering/transactions', '{"providerId":', { 'idempotency-key': 'k' });
    expect(badJson.status).toBe(400);

    expect((await submit(wager(w, { money: { amount: 25, currency: 'BRL' } }))).status).toBe(400);
    expect((await submit(wager(w, { kind: 'JACKPOT' }))).status).toBe(400);
  });

  test('correlationId: devolve o recebido no header e gera um quando ausente', async () => {
    const res = await http.get('/health/live', { 'x-correlation-id': 'corr-123' });
    expect(res.headers.get('x-correlation-id')).toBe('corr-123');
    const generated = await http.get('/health/live');
    expect(generated.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  test('consistente depois de várias operações', async () => {
    const w = await createWallet('100.00');
    await submit(wager(w));
    await submit(wager(w, { kind: 'WIN', money: brl('10.00') }));
    const res = await http.post(`/wallets/${w.walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: w.walletId,
      storedBalance: brl('85.00'),
      calculatedBalance: brl('85.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 3,
    });
  });

  test('divergência é SINALIZADA e contada na métrica, e NÃO corrigida', async () => {
    const w = await createWallet('100.00');

    // simula corrupção: altera o saldo direto no banco, pulando triggers (só o superusuário do teste consegue)
    const orm = app.app.get(MikroORM);
    await orm.em.getConnection().transactional(async (trx) => {
      await orm.em.getConnection().execute(`SET LOCAL session_replication_role = replica`, [], 'run', trx);
      await orm.em.getConnection().execute(`UPDATE wallets SET balance = 90.00 WHERE id = ?`, [w.walletId], 'run', trx);
    });

    const metrics = app.app.get<InMemoryMetrics>(METRICS);
    const before = metrics.counter('wallet_reconciliations_total', { result: 'divergent' });

    const res = await http.post(`/wallets/${w.walletId}/reconciliation`);
    expect(res.body).toMatchObject({
      storedBalance: brl('90.00'),
      calculatedBalance: brl('100.00'),
      difference: brl('-10.00'),
      consistent: false,
    });
    expect(metrics.counter('wallet_reconciliations_total', { result: 'divergent' })).toBe(before + 1);
    expect((await http.get(`/wallets/${w.walletId}`)).body.balance).toEqual(brl('90.00')); // não corrigiu
  });
});

describe('GET /metrics (seção 12)', () => {
  test('formato Prometheus, sem autenticação, com transações por status, duplicatas, latência e outbox lag', async () => {
    const w = await createWallet('100.00');
    const body = wager(w);
    expect((await submit(body)).status).toBe(200);
    expect((await submit(body)).status).toBe(200); // replay → duplicata

    const res = await fetch(`${app.baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();

    expect(text).toMatch(/^wager_transactions_total\{channel="http",status="PROCESSED"\} \d+$/m);
    expect(text).toMatch(/^wager_duplicates_total\{channel="http"\} \d+$/m);
    expect(text).toMatch(/^wager_processing_seconds_count\{channel="http"\} \d+$/m);
    expect(text).toMatch(/^wallet_lock_wait_seconds_bucket\{le="\+Inf"\} \d+$/m);
    expect(text).toMatch(/^outbox_pending_messages \d+$/m);
    expect(text).toMatch(/^outbox_oldest_pending_age_seconds [\d.]+$/m);
    expect(text).toMatch(/^pending_reference_transactions \d+$/m);
    expect(text).toMatch(/^sqs_wager_dlq_messages \d+$/m);
    expect(text).toMatch(/^metrics_collect_errors 0$/m);
  });
});
