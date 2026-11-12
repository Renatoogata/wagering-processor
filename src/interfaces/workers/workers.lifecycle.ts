import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { BackgroundWorker } from './polling-worker';

export const BACKGROUND_WORKERS = Symbol('BACKGROUND_WORKERS');

/**
 * Liga os workers ao ciclo de vida do Nest.
 *
 *  - sobem depois que tudo está pronto (banco, use cases);
 *  - no SIGTERM (enableShutdownHooks no main.ts), `beforeApplicationShutdown` roda
 *    ANTES de o Nest fechar o banco, então o trabalho em andamento termina o commit.
 *
 * A ORDEM da lista é a ordem de parada: primeiro quem RECEBE trabalho (consumer SQS),
 * por último quem ESCOA (relay da outbox). Assim os eventos gerados pelas últimas
 * mensagens ainda têm chance de sair antes de o processo morrer (se não saírem,
 * continuam na outbox e outra instância publica: nada se perde).
 */
@Injectable()
export class WorkersLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(BACKGROUND_WORKERS) private readonly workers: BackgroundWorker[]) {}

  onApplicationBootstrap(): void {
    for (const worker of this.workers) worker.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    for (const worker of this.workers) await worker.stop();
  }
}
