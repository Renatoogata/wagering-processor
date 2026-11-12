import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppLogger, Metrics } from '../../application/ports/observability';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { classifyFailure, type FailureDecision } from './classify-failure';
import { parseWagerMessage, type WagerMessage } from './wager-message';

export interface WagerConsumerConfig {
  /** nome deste consumidor na inbox: (consumerName, messageId) */
  consumerName: string;
  queueUrl: string;
  dlqUrl: string;
  /** entregas antes de desistir e mandar para a DLQ */
  maxAttempts: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  /** long polling: quanto o ReceiveMessage espera por mensagens (0–20s) */
  waitTimeSeconds: number;
  /** mensagens por ReceiveMessage (1–10) */
  batchSize: number;
}

export const defaultConsumerConfig = (queueUrl: string, dlqUrl: string): WagerConsumerConfig => ({
  consumerName: 'wager-transactions',
  queueUrl,
  dlqUrl,
  // < maxReceiveCount do redrive (5 no init-sqs.sh + folga): o consumer decide a DLQ
  // com o motivo; o redrive da SQS é só a rede de segurança (ex.: crash em loop)
  maxAttempts: 4,
  baseDelaySeconds: 2,
  maxDelaySeconds: 60,
  waitTimeSeconds: 10,
  batchSize: 10,
});

/** Use case visto pelo consumer (permite embrulhar em testes sem mock do banco/SQS). */
export type WagerProcessor = Pick<ProcessWagerTransaction, 'execute'>;

/**
 * Consumidor da fila wager-transactions.fifo (seção 10).
 *
 * Garantias:
 *  - MESMO use case da API, com a inbox gravada na MESMA transação SQL;
 *  - ack (DeleteMessage) SÓ depois do commit. Se o processo morrer entre os dois,
 *    a SQS reentrega e a inbox transforma a reentrega em replay (nenhum efeito novo);
 *  - erro classificado em ack / retry com backoff / DLQ (classifyFailure, desafio 5);
 *  - SIGTERM: termina a mensagem em andamento e DEVOLVE a visibilidade das que
 *    ainda não começaram, para outra instância pegar na hora (sem esperar o timeout).
 *
 * Ordem (FIFO): mensagens do mesmo MessageGroupId são processadas em sequência.
 * Se uma não for confirmada (retry), as seguintes do grupo NESTE lote são devolvidas:
 * processar a próxima antes da anterior quebraria a ordem do grupo.
 * Grupos diferentes rodam em paralelo; o lock por wallet cuida do resto.
 */
export class SqsWagerConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();

  constructor(
    private readonly sqs: SQSClient,
    private readonly processor: WagerProcessor,
    private readonly config: WagerConsumerConfig,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.pollLoop();
    this.logger.info('sqs consumer started', { consumerName: this.config.consumerName });
  }

  /** SIGTERM: para de buscar, termina o que está em andamento e devolve o resto. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort(); // corta o long polling em curso
    await this.loop;
    this.logger.info('sqs consumer stopped', { consumerName: this.config.consumerName });
  }

  // ------------------------------------------------------------------- loop

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let messages: Message[];
      try {
        const out = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.queueUrl,
            MaxNumberOfMessages: this.config.batchSize,
            WaitTimeSeconds: this.config.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = out.Messages ?? [];
        failures = 0;
      } catch (error) {
        if (!this.running) break; // abort do stop()
        // SQS fora do ar: espera crescente para não martelar (máx. 30s)
        failures++;
        this.metrics.increment('sqs_receive_errors_total');
        this.logger.error('sqs receive failed', { error: errorMessage(error), failures });
        await sleep(Math.min(1000 * 2 ** failures, 30_000));
        continue;
      }
      await this.handleBatch(messages);
    }
  }

  private async handleBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.all([...groups.values()].map((group) => this.handleGroup(group)));
  }

  private async handleGroup(messages: Message[]): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
      if (!this.running) {
        // SIGTERM chegou: o que não começou volta para a fila imediatamente
        await this.release(messages.slice(i), 'shutdown');
        return;
      }
      const acked = await this.handleMessage(messages[i]!);
      if (!acked) {
        await this.release(messages.slice(i + 1), 'fifo-order');
        return;
      }
    }
  }

  // ------------------------------------------------------------------- uma mensagem

  /** Devolve true se a mensagem saiu da fila (ack ou DLQ). */
  private async handleMessage(m: Message): Promise<boolean> {
    const started = performance.now();
    const receiveCount = Number(m.Attributes?.ApproximateReceiveCount ?? '1');
    let parsed: WagerMessage | undefined;

    try {
      parsed = parseWagerMessage(m.Body);
      const correlationId = m.MessageAttributes?.correlationId?.StringValue ?? parsed.messageId;
      const result = await this.processor.execute({
        idempotencyKey: parsed.idempotencyKey,
        payload: parsed.payload,
        context: { correlationId, causationId: parsed.messageId },
        inbox: { consumerName: this.config.consumerName, messageId: parsed.messageId },
      });

      // aqui o commit JÁ aconteceu; só agora o ack
      this.metrics.increment('wager_transactions_total', { channel: 'sqs', status: result.status });
      if (result.idempotentReplay) this.metrics.increment('wager_duplicates_total', { channel: 'sqs' });
      this.metrics.observe('wager_processing_seconds', (performance.now() - started) / 1000, { channel: 'sqs' });
      this.logger.info('sqs message processed', {
        ...this.logFields(m, parsed),
        correlationId,
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
        receiveCount,
      });
      await this.ack(m, parsed);
      return true;
    } catch (error) {
      const decision = classifyFailure(error, {
        receiveCount,
        maxAttempts: this.config.maxAttempts,
        baseDelaySeconds: this.config.baseDelaySeconds,
        maxDelaySeconds: this.config.maxDelaySeconds,
      });
      return this.applyDecision(m, parsed, error, decision, receiveCount);
    }
  }

  private async applyDecision(
    m: Message,
    parsed: WagerMessage | undefined,
    error: unknown,
    decision: FailureDecision,
    receiveCount: number,
  ): Promise<boolean> {
    this.metrics.increment('sqs_messages_failed_total', { action: decision.action });
    const fields = { ...this.logFields(m, parsed), receiveCount, action: decision.action, error: errorMessage(error) };

    switch (decision.action) {
      case 'ack':
        this.logger.warn('sqs message rejected by business rule', { ...fields, reason: decision.reason });
        await this.ack(m, parsed);
        return true;

      case 'retry':
        this.metrics.increment('sqs_retries_total');
        this.logger.warn('sqs message will be retried', { ...fields, delaySeconds: decision.delaySeconds });
        await this.changeVisibility(m, decision.delaySeconds);
        return false;

      case 'dlq':
        this.logger.error('sqs message sent to DLQ', { ...fields, reason: decision.reason });
        return this.sendToDlq(m, parsed, decision.reason);
    }
  }

  // ------------------------------------------------------------------- operações SQS

  /**
   * Ack = DeleteMessage. Se falhar (SQS fora), NÃO é erro de processamento: o commit
   * já aconteceu. A mensagem volta após o visibility timeout e a inbox a trata como replay.
   */
  private async ack(m: Message, parsed?: WagerMessage): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: m.ReceiptHandle }));
    } catch (error) {
      this.metrics.increment('sqs_ack_errors_total');
      this.logger.warn('sqs ack failed; message will be redelivered and deduplicated by the inbox', {
        ...this.logFields(m, parsed),
        error: errorMessage(error),
      });
    }
  }

  /**
   * DLQ explícita: COPIA para a DLQ com o motivo e só então apaga da principal.
   * Se o processo morrer no meio, a mensagem fica nas duas (duplicata na DLQ, que é
   * inspecionada por gente); o contrário (apagar antes) poderia PERDER a mensagem.
   */
  private async sendToDlq(m: Message, parsed: WagerMessage | undefined, reason: string): Promise<boolean> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.config.dlqUrl,
          MessageBody: m.Body ?? '',
          MessageGroupId: m.Attributes?.MessageGroupId ?? 'dlq',
          MessageDeduplicationId: m.MessageId,
          MessageAttributes: {
            failureReason: { DataType: 'String', StringValue: reason },
            sourceMessageId: { DataType: 'String', StringValue: m.MessageId ?? 'unknown' },
          },
        }),
      );
    } catch (error) {
      // não conseguiu copiar: não apaga. A mensagem volta e o redrive da SQS é a última defesa
      this.logger.error('sqs DLQ send failed', { ...this.logFields(m, parsed), error: errorMessage(error) });
      return false;
    }
    this.metrics.increment('sqs_dlq_messages_total', { reason });
    await this.ack(m, parsed);
    return true;
  }

  private async release(messages: Message[], why: string): Promise<void> {
    if (messages.length === 0) return;
    this.logger.info('sqs messages released', { count: messages.length, why });
    await Promise.all(messages.map((m) => this.changeVisibility(m, 0)));
  }

  private async changeVisibility(m: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.config.queueUrl,
          ReceiptHandle: m.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      // sem problema: a mensagem volta sozinha quando o visibility timeout acabar
      this.logger.warn('sqs change visibility failed', { sqsMessageId: m.MessageId, error: errorMessage(error) });
    }
  }

  /** Campos de rastreio. NUNCA o payload completo (seção 12): só ids. */
  private logFields(m: Message, parsed?: WagerMessage) {
    return {
      consumerName: this.config.consumerName,
      sqsMessageId: m.MessageId,
      messageId: parsed?.messageId,
      walletId: parsed?.payload.walletId,
      providerId: parsed?.payload.providerId,
      externalTransactionId: parsed?.payload.externalTransactionId,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
