import type { AppLogger } from '../../application/ports/observability';

/** Algo que roda em segundo plano e para limpo no SIGTERM. */
export interface BackgroundWorker {
  readonly name: string;
  start(): void;
  /** Para de pegar trabalho novo e espera o que está em andamento terminar. */
  stop(): Promise<void>;
}

export interface PollingWorkerOptions {
  /** espera quando a última rodada não achou nada para fazer */
  idleDelayMs: number;
  /** espera depois de uma rodada que lançou erro (banco fora, por ex.) */
  errorDelayMs: number;
}

/**
 * Loop genérico de polling: roda `tick` em sequência.
 *  - `tick` devolveu > 0 (achou trabalho) → roda de novo NA HORA (escoa backlog rápido);
 *  - devolveu 0 → dorme `idleDelayMs`;
 *  - lançou → loga e dorme `errorDelayMs` (sem derrubar o processo).
 *
 * `stop()` acorda o sono na hora e espera a rodada em andamento terminar: como cada
 * rodada é uma transação, ou ela commita inteira ou é desfeita, nunca fica pela metade.
 *
 * Usado pelo relay da outbox e pelo worker de referências pendentes.
 */
export class PollingWorker implements BackgroundWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    readonly name: string,
    private readonly tick: () => Promise<number>,
    private readonly options: PollingWorkerOptions,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info('worker started', { worker: this.name });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.info('worker stopped', { worker: this.name });
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delay: number;
      try {
        const handled = await this.tick();
        delay = handled > 0 ? 0 : this.options.idleDelayMs;
      } catch (error) {
        this.logger.error('worker tick failed', {
          worker: this.name,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        delay = this.options.errorDelayMs;
      }
      if (delay > 0 && this.running) await this.sleep(delay);
    }
  }

  /** Sono interrompível: stop() resolve a promise na hora. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
