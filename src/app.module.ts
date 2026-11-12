import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../mikro-orm.config';
import { APP_LOGGER, InMemoryMetrics, METRICS, jsonLogger, type AppLogger, type Metrics } from './application/ports/observability';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/repositories';
import { CLOCK, ID_GENERATOR, systemClock, uuidV7Generator, type Clock, type IdGenerator } from './application/ports/system';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { CreateWallet } from './application/wallets/create-wallet';
import { ReconcileWallet } from './application/wallets/reconcile-wallet';
import { WalletQueries } from './application/wallets/wallet-queries';
import { SQS_CLIENT, SqsModule } from './infrastructure/messaging/sqs.module';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-repositories';
import { HealthController } from './interfaces/http/health.controller';
import { ProviderAuthGuard } from './interfaces/http/provider-auth.guard';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { SqsWagerConsumer, defaultConsumerConfig } from './interfaces/messaging/sqs-wager-consumer';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { PublishOutboxBatch } from './application/messaging/publish-outbox-batch';
import { EVENT_PUBLISHER, type EventPublisher } from './application/ports/event-publisher';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { PollingWorker, type BackgroundWorker } from './interfaces/workers/polling-worker';
import { BACKGROUND_WORKERS, WorkersLifecycle } from './interfaces/workers/workers.lifecycle';

const enabled = (flag: string) => process.env[flag] !== 'false';

/**
 * Composição (o "main" da arquitetura hexagonal): aqui, e só aqui, as portas da
 * aplicação são ligadas aos adaptadores concretos. Os casos de uso são classes TS
 * puras (sem decorators do Nest), registradas por factory.
 */
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      useFactory: () => ({ ...buildOrmConfig(), registerRequestContext: false }),
      driver: PostgreSqlDriver,
    }),
    SqsModule,
  ],
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    // ---- adaptadores
    { provide: UNIT_OF_WORK, useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm.em), inject: [MikroORM] },
    { provide: CLOCK, useValue: systemClock },
    { provide: ID_GENERATOR, useValue: uuidV7Generator },
    { provide: APP_LOGGER, useValue: jsonLogger },
    { provide: METRICS, useValue: new InMemoryMetrics() },
    ProviderAuthGuard,

    // ---- casos de uso
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new ProcessWagerTransaction(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: CreateWallet,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWallet(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    { provide: WalletQueries, useFactory: (uow: UnitOfWork) => new WalletQueries(uow), inject: [UNIT_OF_WORK] },
    {
      provide: ReconcileWallet,
      useFactory: (uow: UnitOfWork, logger: AppLogger, metrics: Metrics) => new ReconcileWallet(uow, logger, metrics),
      inject: [UNIT_OF_WORK, APP_LOGGER, METRICS],
    },

    // ---- mensageria
    {
      provide: EVENT_PUBLISHER,
      useFactory: (sqs: SQSClient) =>
        new SqsEventPublisher(sqs, process.env.SQS_EVENTS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wagering-events.fifo'),
      inject: [SQS_CLIENT],
    },
    {
      provide: PublishOutboxBatch,
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, logger: AppLogger, metrics: Metrics) =>
        new PublishOutboxBatch(uow, publisher, clock, logger, metrics),
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_LOGGER, METRICS],
    },

    // ---- workers em segundo plano (ordem = ordem de parada no SIGTERM)
    {
      provide: BACKGROUND_WORKERS,
      useFactory: (
        sqs: SQSClient,
        processWager: ProcessWagerTransaction,
        publishOutbox: PublishOutboxBatch,
        logger: AppLogger,
        metrics: Metrics,
      ): BackgroundWorker[] => {
        const workers: BackgroundWorker[] = [];
        const queueUrl = process.env.SQS_WAGER_QUEUE_URL;
        const dlqUrl = process.env.SQS_WAGER_DLQ_URL;
        // entrada SQS: mesmo use case da API
        if (enabled('SQS_CONSUMER_ENABLED') && queueUrl && dlqUrl) {
          workers.push(new SqsWagerConsumer(sqs, processWager, defaultConsumerConfig(queueUrl, dlqUrl), logger, metrics));
        }
        // relay da outbox: por último, para escoar os eventos das últimas mensagens
        if (enabled('OUTBOX_PUBLISHER_ENABLED')) {
          workers.push(
            new PollingWorker('outbox-publisher', async () => (await publishOutbox.execute()).claimed, { idleDelayMs: 500, errorDelayMs: 2_000 }, logger),
          );
        }
        return workers;
      },
      inject: [SQS_CLIENT, ProcessWagerTransaction, PublishOutboxBatch, APP_LOGGER, METRICS],
    },
    WorkersLifecycle,
  ],
})
export class AppModule {}
