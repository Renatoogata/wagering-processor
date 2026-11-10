import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Response } from 'express';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs.module';

/** Endpoints abertos (sem autenticação), conforme seção 2 do desafio. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /** Liveness: o processo está de pé. Não toca dependências externas. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. 503 se qualquer um falhar. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const ok = postgres === 'up' && sqs === 'up';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  private async checkPostgres(): Promise<'up' | 'down'> {
    try {
      await withTimeout(this.orm.em.getConnection().execute('select 1'), 2000);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkSqs(): Promise<'up' | 'down'> {
    try {
      await withTimeout(
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: process.env.SQS_WAGER_QUEUE_URL,
            AttributeNames: ['QueueArn'],
          }),
        ),
        2000,
      );
      return 'up';
    } catch {
      return 'down';
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}
