import type { EventPublisher } from '../ports/event-publisher';
import type { AppLogger, Metrics } from '../ports/observability';
import type { UnitOfWork } from '../ports/repositories';
import type { Clock } from '../ports/system';

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Relay da Transactional Outbox (seção 11): publica UM lote de eventos pendentes.
 *
 * Tudo numa transação SQL:
 *   1. SELECT ... FOR UPDATE SKIP LOCKED   ← pega um lote que nenhum outro publisher pegou
 *   2. publica no broker
 *   3. marca published_at (ou agenda retry com backoff)
 *   4. commit                              ← solta as linhas
 *
 * Por que é seguro com N publishers?
 * O SKIP LOCKED faz cada publisher pular as linhas travadas pelos outros: ninguém
 * espera e ninguém pega a mesma linha ao mesmo tempo. Sem o SKIP LOCKED, o 2º publisher
 * ficaria parado esperando o 1º (fila em série); sem lock nenhum, os dois publicariam tudo.
 *
 * E se o processo morrer?
 *  - antes do commit (inclusive DEPOIS de publicar): o Postgres desfaz a transação e solta
 *    as linhas; outro publisher pega e publica de novo → DUPLICATA. É o at-least-once:
 *    o consumidor deduplica pelo eventId (e a SQS FIFO ainda descarta a cópia em até 5 min,
 *    porque usamos o eventId como MessageDeduplicationId).
 *  - depois do commit: já está marcado; nada a fazer.
 * O que NUNCA acontece: perder um evento confirmado, ou publicar antes do commit do negócio
 * (a linha da outbox só existe depois desse commit).
 *
 * Trade-off: a transação fica aberta durante a chamada ao broker. Por isso o lote é
 * pequeno e o adaptador tem timeout. A alternativa (lease: marcar "em publicação até T",
 * commitar, publicar, marcar de novo) evita a transação longa, mas tem mais estados e mais
 * casos de borda. Ver ARCHITECTURE.md.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly batchSize = 10,
  ) {}

  async execute(): Promise<PublishOutboxResult> {
    return this.uow.run(async (repos) => {
      const due = await repos.outbox.claimDue(this.clock.now(), this.batchSize);
      if (due.length === 0) return { claimed: 0, published: 0, failed: 0 };

      let failures: Map<string, string>;
      try {
        failures = new Map((await this.publisher.publish(due)).map((f) => [f.id, f.error]));
      } catch (error) {
        // broker inteiro fora: o lote todo volta com backoff
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        failures = new Map(due.map((m) => [m.id, message]));
      }

      const at = this.clock.now();
      for (const message of due) {
        const error = failures.get(message.id);
        if (error === undefined) {
          message.markPublished(at);
          // outbox lag: quanto tempo o evento esperou entre o commit do negócio e a publicação
          this.metrics.observe('outbox_lag_seconds', (at.getTime() - message.occurredAt.getTime()) / 1000);
        } else {
          message.scheduleRetry(at, error);
          this.logger.warn('outbox publish failed; retry scheduled', {
            eventId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt.toISOString(),
            error,
          });
        }
        await repos.outbox.update(message);
      }

      const failed = failures.size;
      const published = due.length - failed;
      this.metrics.increment('outbox_published_total', {}, published);
      if (failed) this.metrics.increment('outbox_publish_failures_total', {}, failed);
      return { claimed: due.length, published, failed };
    });
  }
}
