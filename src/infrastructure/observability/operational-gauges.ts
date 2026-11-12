import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OperationalGauges } from '../../application/ports/observability';

/**
 * Medidores lidos NA HORA da coleta (GET /metrics), direto da fonte de verdade.
 * Por virem do banco/fila, são iguais em todas as instâncias (não somar no Prometheus: usar max).
 *
 *  - outbox_pending_messages              quantos eventos confirmados ainda não saíram
 *  - outbox_oldest_pending_age_seconds    OUTBOX LAG: há quanto tempo o mais antigo espera
 *                                         (0 = em dia; subindo sem parar = publisher parado/broker fora)
 *  - pending_reference_transactions       REFUND/ROLLBACK aguardando a referência
 *  - sqs_wager_queue_messages             backlog da fila de entrada
 *  - sqs_wager_dlq_messages               mensagens na DLQ (deveria ser 0; > 0 pede alguém olhar)
 *
 * Uma fonte fora do ar não derruba o /metrics: o medidor dela simplesmente não aparece
 * (e `metrics_collect_errors` indica quantas falharam).
 */
export class SqlAndSqsGauges implements OperationalGauges {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    private readonly queues: { wagerQueueUrl?: string; wagerDlqUrl?: string },
  ) {}

  async collect(): Promise<Record<string, number>> {
    const gauges: Record<string, number> = {};
    let errors = 0;
    const attempt = async (fn: () => Promise<void>) => {
      try {
        await withTimeout(fn(), 2_000);
      } catch {
        errors++;
      }
    };

    await Promise.all([
      attempt(async () => {
        const [row] = await this.em.fork().getConnection().execute<{ pending: string; oldest_age: string | null }[]>(
          `SELECT count(*) AS pending,
                  extract(epoch FROM now() - min(occurred_at)) AS oldest_age
             FROM outbox_messages
            WHERE published_at IS NULL`,
        );
        gauges.outbox_pending_messages = Number(row!.pending);
        gauges.outbox_oldest_pending_age_seconds = Math.max(0, Number(row!.oldest_age ?? 0));
      }),
      attempt(async () => {
        const [row] = await this.em.fork().getConnection().execute<{ n: string }[]>(
          `SELECT count(*) AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
        );
        gauges.pending_reference_transactions = Number(row!.n);
      }),
      attempt(async () => {
        if (this.queues.wagerQueueUrl) gauges.sqs_wager_queue_messages = await this.depth(this.queues.wagerQueueUrl);
      }),
      attempt(async () => {
        if (this.queues.wagerDlqUrl) gauges.sqs_wager_dlq_messages = await this.depth(this.queues.wagerDlqUrl);
      }),
    ]);

    gauges.metrics_collect_errors = errors;
    return gauges;
  }

  private async depth(queueUrl: string): Promise<number> {
    const out = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    return (
      Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}
