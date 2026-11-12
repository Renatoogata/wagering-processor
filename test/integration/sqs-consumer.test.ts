import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ChangeMessageVisibilityCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InMemoryMetrics, type AppLogger } from '../../src/application/ports/observability';
import { TransientInfrastructureError, type UnitOfWork } from '../../src/application/ports/repositories';
import { systemClock, uuidV7Generator } from '../../src/application/ports/system';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering';
import { LedgerDirection, type Wallet } from '../../src/domain/wallet';
import { parseWagerMessage } from '../../src/interfaces/messaging/wager-message';
import {
  SqsWagerConsumer,
  type WagerConsumerConfig,
  type WagerProcessor,
} from '../../src/interfaces/messaging/sqs-wager-consumer';
import { expectWalletMatchesLedger, id, openWallet, startDatabase } from './support/database';
import { createTestQueues, queueDepth, receiveAll, sendRaw, sqsClient, waitFor, type TestQueues } from './support/sqs';

/**
 * Consumer SQS contra LocalStack e Postgres REAIS (seção 13: "inbox e redelivery",
 * "retry e DLQ", concorrência 5 "worker morto depois do commit e antes do ack").
 */
// o padrão do Bun (5s) é menor que retries com backoff real (1s + 2s + long polling)
setDefaultTimeout(30_000);

let orm: MikroORM;
let uow: UnitOfWork;
let useCase: ProcessWagerTransaction;
let sqs: SQSClient;

const silent: AppLogger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  ({ orm, uow } = await startDatabase());
  useCase = new ProcessWagerTransaction(uow, systemClock, uuidV7Generator);
  sqs = sqsClient();
});
afterAll(async () => {
  await orm.close(true);
  sqs.destroy();
});

// --------------------------------------------------------------- ambiente por teste

interface Harness {
  queues: TestQueues;
  metrics: InMemoryMetrics;
  consumer: SqsWagerConsumer;
  consumerName: string;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function harness(processor: WagerProcessor = useCase, overrides: Partial<WagerConsumerConfig> = {}): Promise<Harness> {
  const queues = await createTestQueues(sqs, 'it-consumer');
  const metrics = new InMemoryMetrics();
  const consumerName = `it-${id()}`;
  const consumer = newConsumer(queues, metrics, consumerName, processor, overrides);
  cleanups.push(async () => {
    await consumer.stop();
    await queues.destroy();
  });
  return { queues, metrics, consumer, consumerName };
}

function newConsumer(
  queues: TestQueues,
  metrics: InMemoryMetrics,
  consumerName: string,
  processor: WagerProcessor = useCase,
  overrides: Partial<WagerConsumerConfig> = {},
): SqsWagerConsumer {
  const config: WagerConsumerConfig = {
    consumerName,
    queueUrl: queues.queueUrl,
    dlqUrl: queues.dlqUrl,
    maxAttempts: 3,
    baseDelaySeconds: 1,
    maxDelaySeconds: 2,
    waitTimeSeconds: 1,
    batchSize: 10,
    ...overrides,
  };
  const consumer = new SqsWagerConsumer(sqs, processor, config, silent, metrics);
  cleanups.push(() => consumer.stop());
  return consumer;
}

// --------------------------------------------------------------- mensagens

function envelope(wallet: Wallet, kind: string, amount: string, overrides: { messageId?: string; externalTransactionId?: string; currency?: string } = {}) {
  const externalTransactionId = overrides.externalTransactionId ?? id();
  return {
    messageId: overrides.messageId ?? `msg-${id()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: overrides.currency ?? 'BRL' },
    },
  };
}

/** Na produção, o produtor usa walletId como MessageGroupId: ordem por wallet. */
const send = (h: Harness, msg: ReturnType<typeof envelope>) => sendRaw(sqs, h.queues.queueUrl, JSON.stringify(msg), msg.data.walletId);

// --------------------------------------------------------------- consultas

async function debits(walletId: string): Promise<number> {
  const page = await uow.run((repos) => repos.ledger.listByWallet(walletId, { limit: 1000 }));
  return page.entries.filter((e) => e.direction === LedgerDirection.Debit).length;
}

async function inboxCount(consumerName: string): Promise<number> {
  const rows = await orm.em
    .fork()
    .getConnection()
    .execute<{ n: string }[]>(`SELECT count(*) AS n FROM inbox_messages WHERE consumer_name = ?`, [consumerName]);
  return Number(rows[0]!.n);
}

async function balance(walletId: string): Promise<string> {
  return (await expectWalletMatchesLedger(uow, walletId)).toJSON().amount;
}

const queueEmpty = (h: Harness) => async () => (await queueDepth(sqs, h.queues.queueUrl)) === 0;

// =============================================================== testes

describe('consumer SQS: caminho feliz e inbox', () => {
  test('processa uma BET da fila: debita, grava a inbox e só então confirma', async () => {
    const h = await harness();
    const wallet = await openWallet(uow, '100.00');
    await send(h, envelope(wallet, 'BET', '25.00'));

    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(await balance(wallet.id)).toBe('75.00');
    expect(await inboxCount(h.consumerName)).toBe(1);
    expect(h.metrics.counter('wager_transactions_total', { channel: 'sqs', status: Status.Processed })).toBe(1);
  });

  test('redelivery: o mesmo messageId chega 2x → um único débito, as duas confirmadas', async () => {
    const h = await harness();
    const wallet = await openWallet(uow, '100.00');
    const msg = envelope(wallet, 'BET', '25.00');
    await send(h, msg);
    await send(h, msg); // dedupId diferente: a SQS FIFO NÃO barra; quem barra é a inbox

    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(await debits(wallet.id)).toBe(1);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(await inboxCount(h.consumerName)).toBe(1);
    expect(h.metrics.counter('wager_duplicates_total', { channel: 'sqs' })).toBe(1);
  });

  test('a mesma operação chega por HTTP e depois por SQS → a segunda é replay', async () => {
    const h = await harness();
    const wallet = await openWallet(uow, '100.00');
    const msg = envelope(wallet, 'BET', '25.00');
    const parsed = parseWagerMessage(JSON.stringify(msg));
    await useCase.execute({ idempotencyKey: parsed.idempotencyKey, payload: parsed.payload, context: { correlationId: id() } });

    await send(h, msg);
    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(await debits(wallet.id)).toBe(1);
    expect(h.metrics.counter('wager_duplicates_total', { channel: 'sqs' })).toBe(1);
  });

  test('ordem FIFO por wallet: BET 80 e depois BET 30 com saldo 100 → a 2ª é rejeitada', async () => {
    const h = await harness();
    const wallet = await openWallet(uow, '100.00');
    await send(h, envelope(wallet, 'BET', '80.00'));
    await send(h, envelope(wallet, 'BET', '30.00'));

    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(await balance(wallet.id)).toBe('20.00');
    expect(h.metrics.counter('wager_transactions_total', { channel: 'sqs', status: Status.Rejected })).toBe(1);
  });
});

describe('consumer SQS: classificação de erros (desafio 5)', () => {
  test('REJECTED (saldo insuficiente) não é erro: ack, nada na DLQ', async () => {
    const h = await harness();
    const wallet = await openWallet(uow, '10.00');
    await send(h, envelope(wallet, 'BET', '25.00'));

    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(await balance(wallet.id)).toBe('10.00');
    expect(await queueDepth(sqs, h.queues.dlqUrl)).toBe(0);
  });

  test('negócio (moeda diferente da wallet) → ack, nada na DLQ', async () => {
    const h = await harness();
    const wallet = await openWallet(uow, '100.00');
    await send(h, envelope(wallet, 'BET', '25.00', { currency: 'USD' }));

    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(await balance(wallet.id)).toBe('100.00');
    expect(await queueDepth(sqs, h.queues.dlqUrl)).toBe(0);
    expect(h.metrics.counter('sqs_messages_failed_total', { action: 'ack' })).toBe(1);
  });

  test('JSON inválido → DLQ com o motivo', async () => {
    const h = await harness();
    await sendRaw(sqs, h.queues.queueUrl, '{definitely not json', 'g-1');

    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    const [dead] = await receiveAll(sqs, h.queues.dlqUrl);
    expect(dead?.Body).toBe('{definitely not json');
    expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe('INVALID_MESSAGE');
  });

  test('messageId reaproveitado com OUTRO conteúdo → DLQ, sem efeito no saldo', async () => {
    const h = await harness();
    const wallet = await openWallet(uow, '100.00');
    const first = envelope(wallet, 'BET', '25.00');
    const impostor = envelope(wallet, 'BET', '50.00', { messageId: first.messageId });
    await send(h, first);
    await send(h, impostor);

    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(await balance(wallet.id)).toBe('75.00');
    const [dead] = await receiveAll(sqs, h.queues.dlqUrl);
    expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe('INBOX_MESSAGE_CONFLICT');
  });

  test('falha transitória: retry com backoff e depois processa uma única vez', async () => {
    let calls = 0;
    const flaky: WagerProcessor = {
      execute: async (cmd) => {
        calls++;
        if (calls <= 2) throw new TransientInfrastructureError(new Error('ECONNREFUSED'));
        return useCase.execute(cmd);
      },
    };
    const h = await harness(flaky);
    const wallet = await openWallet(uow, '100.00');
    await send(h, envelope(wallet, 'BET', '25.00'));

    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(calls).toBe(3);
    expect(h.metrics.counter('sqs_retries_total')).toBe(2);
    expect(await debits(wallet.id)).toBe(1);
    expect(await queueDepth(sqs, h.queues.dlqUrl)).toBe(0);
  });

  test('falha transitória que não passa → DLQ após o limite de tentativas', async () => {
    let calls = 0;
    const down: WagerProcessor = {
      execute: async () => {
        calls++;
        throw new TransientInfrastructureError(new Error('ECONNREFUSED'));
      },
    };
    const h = await harness(down);
    const wallet = await openWallet(uow, '100.00');
    await send(h, envelope(wallet, 'BET', '25.00'));

    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(calls).toBe(3); // maxAttempts
    const [dead] = await receiveAll(sqs, h.queues.dlqUrl);
    expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe('MAX_ATTEMPTS_EXCEEDED');
    expect(await balance(wallet.id)).toBe('100.00');
  });
});

describe('consumer SQS: falhas de processo', () => {
  test('concorrência 5: worker morre DEPOIS do commit e ANTES do ack → redelivery vira replay', async () => {
    const h = await harness();
    const wallet = await openWallet(uow, '100.00');
    const msg = envelope(wallet, 'BET', '25.00');
    await send(h, msg);

    // "worker A": recebe, processa (commit com inbox) e MORRE sem dar ack
    const [received] = await receiveAll(sqs, h.queues.queueUrl);
    const parsed = parseWagerMessage(received!.Body);
    await useCase.execute({
      idempotencyKey: parsed.idempotencyKey,
      payload: parsed.payload,
      context: { correlationId: parsed.messageId },
      inbox: { consumerName: h.consumerName, messageId: parsed.messageId },
    });
    // o visibility timeout do worker morto expira (encurtamos para não esperar 30s)
    await sqs.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: h.queues.queueUrl, ReceiptHandle: received!.ReceiptHandle, VisibilityTimeout: 0 }),
    );

    // "worker B" recebe a MESMA mensagem de novo
    h.consumer.start();
    await waitFor('fila vazia', queueEmpty(h));

    expect(await debits(wallet.id)).toBe(1);
    expect(await balance(wallet.id)).toBe('75.00');
    expect(h.metrics.counter('wager_duplicates_total', { channel: 'sqs' })).toBe(1);
  });

  test('SIGTERM: termina a mensagem em andamento e devolve as outras para a fila na hora', async () => {
    let started = 0;
    const slow: WagerProcessor = {
      execute: async (cmd) => {
        started++;
        await new Promise((r) => setTimeout(r, 700));
        return useCase.execute(cmd);
      },
    };
    const h = await harness(slow);
    const wallet = await openWallet(uow, '100.00');
    for (const amount of ['10.00', '20.00', '30.00']) await send(h, envelope(wallet, 'BET', amount));

    h.consumer.start();
    await waitFor('primeira mensagem em andamento', async () => started === 1);
    await h.consumer.stop(); // SIGTERM

    // a que estava em andamento terminou (commit + ack)...
    expect(started).toBe(1);
    expect(await balance(wallet.id)).toBe('90.00');
    // ...e as outras estão VISÍVEIS de novo (não presas por 30s de visibility timeout)
    await waitFor('2 mensagens visíveis', async () => (await queueDepth(sqs, h.queues.queueUrl)) === 2, 3_000);
    const visible = await receiveAll(sqs, h.queues.queueUrl, 0);
    expect(visible.length).toBeGreaterThan(0);
    for (const m of visible) {
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: h.queues.queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }));
    }

    // outra instância assume e termina o trabalho
    const next = newConsumer(h.queues, h.metrics, h.consumerName);
    next.start();
    await waitFor('fila vazia', queueEmpty(h));
    expect(await balance(wallet.id)).toBe('40.00');
    expect(await inboxCount(h.consumerName)).toBe(3);
  });
});
