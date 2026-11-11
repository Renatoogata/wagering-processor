import type { INestApplication } from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../../application/ports/observability';
import { ID_GENERATOR, type IdGenerator } from '../../application/ports/system';
import { ApplicationExceptionFilter } from './application-exception.filter';
import { correlationIdMiddleware } from './request-context';

/** Configuração HTTP compartilhada por main.ts e pelos testes e2e (mesmo comportamento nos dois). */
export function configureHttp(app: INestApplication): void {
  const ids = app.get<IdGenerator>(ID_GENERATOR);
  app.use(correlationIdMiddleware(() => ids.next()));
  app.useGlobalFilters(new ApplicationExceptionFilter(app.get<AppLogger>(APP_LOGGER)));
}
