import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutboxBatch } from '../../src/application/messaging/publish-outbox-batch';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import { InMemoryMetrics, type AppLogger } from '../../src/application/ports/observability';
import type { UnitOfWork } from '../../src/application/ports/repositories';
import { systemClock, uuidV7Generator, type Clock } from '../../src/application/ports/system';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering';
import type { Wallet } from '../../src/domain/wallet';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { expectWalletMatchesLedger, id, openWallet, startDatabase } from './support/database';
import { createTestQueues, receiveAll, sqsClient, type TestQueues } from './support/sqs';

/**
 * Relay da outbox contra Postgres e LocalStack REAIS (seção 11 e seção 13:
 * "publishers concorrentes sobre a mesma outbox", concorrência 6).
 */
setDefaultTimeout(30_000);

let orm: MikroORM;
let uow: UnitOfWork;
let useCase: ProcessWagerTransaction;
let sqs: SQSClient;
let queues: TestQueues;
let sqsPublisher: SqsEventPublisher;

const silent: AppLogger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  ({ orm, uow } = await startDatabase());
  useCase = new ProcessWagerTransaction(uow, systemClock, uuidV7Generator);
  sqs = sqsClient();
  queues = await createTestQueues(sqs, 'it-events');
  sqsPublisher = new SqsEventPublisher(sqs, queues.queueUrl);
  // a outbox é compartilhada com as outras suítes: o backlog que elas deixaram não
  // interessa aqui (e publicá-lo só deixaria o teste lento)
  await sql(`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`);
});
afterAll(async () => {
  await queues.destroy();
  sqs.destroy();
  await orm.close(true);
});

// --------------------------------------------------------------- helpers

function sql<T = Record<string, unknown>[]>(query: string, params: unknown[] = []): Promise<T> {
  return orm.em.fork().getConnection().execute(query, params) as Promise<T>;
}

/** Faz uma BET (que grava 2 eventos na outbox) e devolve os eventIds gravados. */
async function bet(wallet: Wallet, amount = '10.00'): Promise<string[]> {
  const externalTransactionId = id();
  const result = await useCase.execute({
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payload: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: Kind.Bet,
      money: { amount, currency: 'BRL' },
    },
    context: { correlationId: id() },
  });
  const rows = await sql<{ id: string }[]>(
    `SELECT id FROM outbox_messages WHERE aggregate_id IN (?, ?) AND occurred_at >= now() - interval '1 minute'
      AND payload->'data'->>'transactionId' = ? ORDER BY seq`,
    [result.transactionId, wallet.id, result.transactionId],
  );
  return rows.map((r) => r.id);
}

async function outboxRow(eventId: string) {
  const [row] = await sql<{ published_at: Date | null; attempts: number; next_attempt_at: Date; last_error: string | null }[]>(
    `SELECT published_at, attempts, next_attempt_at, last_error FROM outbox_messages WHERE id = ?`,
    [eventId],
  );
  return row!;
}

/** Publisher que registra quantas vezes cada evento foi publicado (e pode ser lento). */
function recording(inner: EventPublisher, delayMs = 0) {
  const counts = new Map<string, number>();
  const publisher: EventPublisher = {
    publish: async (messages) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      for (const m of messages) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
      return inner.publish(messages);
    },
  };
  return { publisher, counts };
}

function relay(publisher: EventPublisher, options: { clock?: Clock; uow?: UnitOfWork; metrics?: InMemoryMetrics } = {}) {
  return new PublishOutboxBatch(
    options.uow ?? uow,
    publisher,
    options.clock ?? systemClock,
    silent,
    options.metrics ?? new InMemoryMetrics(),
    10,
  );
}

/** Roda o relay até não achar mais nada (como o PollingWorker faria). Devolve quantas rodadas tiveram trabalho. */
async function drain(r: PublishOutboxBatch): Promise<number> {
  let rounds = 0;
  while ((await r.execute()).claimed > 0) rounds++;
  return rounds;
}

/** Lê (e apaga) tudo que está na fila de eventos de teste. */
async function consumeEvents(): Promise<{ eventId: string; groupId?: string; eventType?: string }[]> {
  const events: { eventId: string; groupId?: string; eventType?: string }[] = [];
  for (;;) {
    const batch = await receiveAll(sqs, queues.queueUrl, 1);
    if (batch.length === 0) return events;
    for (const m of batch) {
      events.push({
        eventId: JSON.parse(m.Body!).eventId,
        groupId: m.Attributes?.MessageGroupId,
        eventType: m.MessageAttributes?.eventType?.StringValue,
      });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queues.queueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
}

// =============================================================== testes

describe('relay da outbox', () => {
  test('publica os eventos DEPOIS do commit e marca published_at', async () => {
    const wallet = await openWallet(uow, '100.00');
    const eventIds = await bet(wallet);
    expect(eventIds).toHaveLength(2); // WagerTransactionProcessed + WalletBalanceChanged
    expect((await outboxRow(eventIds[0]!)).published_at).toBeNull();

    const metrics = new InMemoryMetrics();
    await drain(relay(sqsPublisher, { metrics }));

    for (const eventId of eventIds) expect((await outboxRow(eventId)).published_at).not.toBeNull();
    const published = (await consumeEvents()).filter((e) => eventIds.includes(e.eventId));
    expect(published.map((e) => e.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    // MessageGroupId = aggregateId: o evento da wallet sai no grupo da wallet
    expect(published.find((e) => e.eventType === 'WalletBalanceChanged')?.groupId).toBe(wallet.id);
    expect(metrics.counter('outbox_published_total')).toBe(2);
  });

  test('concorrência 6: três publishers na mesma outbox → cada evento publicado exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, () => openWallet(uow, '100.00')));
    const eventIds = (await Promise.all(wallets.flatMap((w) => [bet(w, '10.00'), bet(w, '5.00')]))).flat();
    expect(eventIds).toHaveLength(60);

    const { publisher, counts } = recording(sqsPublisher, 30); // lento: força os três a se sobreporem
    const rounds = await Promise.all([drain(relay(publisher)), drain(relay(publisher)), drain(relay(publisher))]);

    for (const eventId of eventIds) {
      expect(counts.get(eventId)).toBe(1);
      expect((await outboxRow(eventId)).published_at).not.toBeNull();
    }
    // SKIP LOCKED dividiu o trabalho: mais de um publisher pegou lotes
    expect(rounds.filter((r) => r > 0).length).toBeGreaterThanOrEqual(2);
    for (const w of wallets) await expectWalletMatchesLedger(uow, w.id);
    await consumeEvents();
  });

  test('broker fora do ar: o evento NÃO se perde, ganha backoff e sai quando o broker volta', async () => {
    const wallet = await openWallet(uow, '100.00');
    const eventIds = await bet(wallet);

    let now = new Date();
    const clock: Clock = { now: () => now };
    const down: EventPublisher = {
      publish: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const metrics = new InMemoryMetrics();
    await relay(down, { clock, metrics }).execute();

    const failed = await outboxRow(eventIds[0]!);
    expect(failed.published_at).toBeNull();
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).toContain('ECONNREFUSED');
    expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(now.getTime()); // backoff
    expect(metrics.counter('outbox_publish_failures_total')).toBeGreaterThanOrEqual(2);

    // antes do backoff vencer, ninguém pega
    const { publisher, counts } = recording(sqsPublisher);
    await drain(relay(publisher, { clock }));
    expect(counts.get(eventIds[0]!)).toBeUndefined();

    // broker voltou e o backoff venceu
    now = new Date(now.getTime() + 5_000);
    await drain(relay(publisher, { clock }));
    for (const eventId of eventIds) {
      expect(counts.get(eventId)).toBe(1);
      expect((await outboxRow(eventId)).published_at).not.toBeNull();
    }
    await consumeEvents();
  });

  test('seção 11: processo morre DEPOIS de publicar e ANTES do commit → outra instância republica, e a duplicata é segura', async () => {
    const wallet = await openWallet(uow, '100.00');
    const eventIds = await bet(wallet);

    // instância A: publica de verdade e "morre" antes do commit (a transação é desfeita)
    const dying: UnitOfWork = {
      run: (work) =>
        uow.run(async (repos) => {
          await work(repos);
          throw new Error('process killed before commit');
        }),
    };
    const { publisher, counts } = recording(sqsPublisher);
    await expect(relay(publisher, { uow: dying }).execute()).rejects.toThrow('process killed');
    for (const eventId of eventIds) expect((await outboxRow(eventId)).published_at).toBeNull(); // rollback

    // instância B assume
    await drain(relay(publisher));
    for (const eventId of eventIds) {
      expect(counts.get(eventId)).toBe(2); // at-least-once: publicado duas vezes...
      expect((await outboxRow(eventId)).published_at).not.toBeNull();
    }

    // ...mas como MessageDeduplicationId = eventId, a SQS FIFO entrega uma cópia só
    const delivered = (await consumeEvents()).filter((e) => eventIds.includes(e.eventId));
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered.map((e) => e.eventId)).size).toBe(2);
  });
});
