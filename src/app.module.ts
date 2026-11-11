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
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-repositories';
import { HealthController } from './interfaces/http/health.controller';
import { ProviderAuthGuard } from './interfaces/http/provider-auth.guard';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

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
  ],
})
export class AppModule {}
