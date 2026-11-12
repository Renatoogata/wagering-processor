import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishFailure } from '../../application/ports/event-publisher';
import type { OutboxMessage } from '../../domain/messaging';

/** SendMessageBatch aceita no máximo 10 mensagens por chamada. */
const SQS_BATCH_LIMIT = 10;

/**
 * Publica eventos na fila wagering-events.fifo.
 *
 *  - MessageGroupId = aggregateId: eventos do mesmo agregado (wallet ou transação)
 *    saem em ordem dentro de um lote;
 *  - MessageDeduplicationId = eventId: se o relay publicar a mesma linha duas vezes
 *    (crash antes do commit), a SQS FIFO descarta a cópia dentro da janela de 5 min.
 *    Fora da janela, o consumidor deduplica pelo eventId (at-least-once).
 *  - timeout por chamada: o relay segura as linhas travadas enquanto publica, então
 *    um broker lento não pode prender a transação indefinidamente.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishFailure[]> {
    const failures: PublishFailure[] = [];
    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + SQS_BATCH_LIMIT);
      const out = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: chunk.map((m, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(m.payload),
            MessageGroupId: m.aggregateId,
            MessageDeduplicationId: m.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: m.eventType },
              eventVersion: { DataType: 'Number', StringValue: String(m.eventVersion) },
              correlationId: { DataType: 'String', StringValue: m.payload.correlationId },
            },
          })),
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
      for (const failed of out.Failed ?? []) {
        const message = chunk[Number(failed.Id)];
        if (message) failures.push({ id: message.id, error: `${failed.Code}: ${failed.Message ?? ''}` });
      }
    }
    return failures;
  }
}
