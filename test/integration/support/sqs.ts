import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

/**
 * SQS REAL (LocalStack do docker compose). Cada suíte cria filas FIFO com nome único
 * (principal + DLQ com redrive), então testes não disputam mensagens entre si nem
 * com uma instância da aplicação rodando.
 */
export function sqsClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  destroy(): Promise<void>;
}

export async function createTestQueues(sqs: SQSClient, prefix: string, maxReceiveCount = 10): Promise<TestQueues> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: `${prefix}-${suffix}-dlq.fifo`, Attributes: { FifoQueue: 'true' } }),
  );
  const dlqArn = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${prefix}-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn.Attributes!.QueueArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  const queueUrl = main.QueueUrl!;
  const dlqUrl = dlq.QueueUrl!;
  return {
    queueUrl,
    dlqUrl,
    destroy: async () => {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

/** Envia um corpo cru. dedupId diferente a cada envio: simula o produtor reenviando. */
export async function sendRaw(sqs: SQSClient, queueUrl: string, body: string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

/** Mensagens visíveis + em voo (ainda não confirmadas) de uma fila. */
export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

export async function receiveAll(sqs: SQSClient, queueUrl: string, waitTimeSeconds = 1): Promise<Message[]> {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      MessageSystemAttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    }),
  );
  return out.Messages ?? [];
}

/** Espera uma condição assíncrona (polling), falhando com mensagem clara no timeout. */
export async function waitFor(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for: ${description}`);
}
