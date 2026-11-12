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
import { SqsConsumerLifecycle, WAGER_CONSUMER } from './interfaces/messaging/sqs-consumer.lifecycle';
import { SqsWagerConsumer, defaultConsumerConfig } from './interfaces/messaging/sqs-wager-consumer';
import type { SQSClient } from '@aws-sdk/client-sqs';

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

    // ---- entrada SQS (mesmo use case da API)
    {
      provide: WAGER_CONSUMER,
      useFactory: (sqs: SQSClient, useCase: ProcessWagerTransaction, logger: AppLogger, metrics: Metrics) => {
        const queueUrl = process.env.SQS_WAGER_QUEUE_URL;
        const dlqUrl = process.env.SQS_WAGER_DLQ_URL;
        if (process.env.SQS_CONSUMER_ENABLED === 'false' || !queueUrl || !dlqUrl) return undefined;
        return new SqsWagerConsumer(sqs, useCase, defaultConsumerConfig(queueUrl, dlqUrl), logger, metrics);
      },
      inject: [SQS_CLIENT, ProcessWagerTransaction, APP_LOGGER, METRICS],
    },
    SqsConsumerLifecycle,
  ],
})
export class AppModule {}
