import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../mikro-orm.config';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { HealthController } from './interfaces/http/health.controller';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      useFactory: () => ({ ...buildOrmConfig(), registerRequestContext: false }),
      driver: PostgreSqlDriver,
    }),
    SqsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
