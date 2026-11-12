import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { SqsWagerConsumer } from './sqs-wager-consumer';

export const WAGER_CONSUMER = Symbol('WAGER_CONSUMER');

/**
 * Liga o consumer ao ciclo de vida do Nest:
 *  - sobe depois que tudo está pronto (banco, use cases);
 *  - no SIGTERM (enableShutdownHooks no main.ts), `beforeApplicationShutdown` roda
 *    ANTES de o Nest fechar as conexões do banco, então a mensagem em andamento
 *    consegue terminar o commit e o ack.
 *
 * `undefined` = consumer desligado (SQS_CONSUMER_ENABLED=false ou fila não configurada).
 */
@Injectable()
export class SqsConsumerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(WAGER_CONSUMER) private readonly consumer: SqsWagerConsumer | undefined) {}

  onApplicationBootstrap(): void {
    this.consumer?.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }
}
