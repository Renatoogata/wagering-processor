import type { IntegrationEvent, IntegrationEventEnvelope } from '../events';
import { OutboxAlreadyPublishedError } from './messaging-errors';

export interface OutboxRetryPolicyOptions {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Backoff da publicação de eventos.
 *
 * Diferente da ReferenceRetryPolicy, aqui NÃO existe limite de tentativas:
 * o evento já está confirmado no banco, e "perder evento confirmado" é proibido
 * (seção 3). Se o broker ficar fora do ar por horas, o evento espera — e o
 * problema aparece nas métricas (outbox lag, attempts), não num descarte silencioso.
 *
 * Teto baixo (1 min) porque, quando o broker volta, queremos escoar rápido.
 */
export class OutboxRetryPolicy {
  static readonly DEFAULT = new OutboxRetryPolicy({ baseDelayMs: 1_000, maxDelayMs: 60_000 });

  constructor(private readonly options: OutboxRetryPolicyOptions) {}

  /** @param attempts tentativas que já falharam (>= 1) */
  delayMs(attempts: number): number {
    const exponential = this.options.baseDelayMs * 2 ** Math.max(0, attempts - 1);
    return Math.min(exponential, this.options.maxDelayMs);
  }
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: IntegrationEventEnvelope<unknown>;
  occurredAt: Date;
  attempts: number;
  /** no schema é NOT NULL: uma mensagem nova já nasce "devida" */
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

/** Limite do texto de erro guardado: suficiente para diagnóstico, sem estourar a linha. */
const MAX_ERROR_LENGTH = 500;

/**
 * Um evento de integração esperando para ser publicado (Transactional Outbox, seção 11).
 *
 * A ideia central: o evento é gravado NA MESMA transação SQL que mudou o saldo.
 * Se o commit acontece, o evento existe; se dá rollback, o evento também some.
 * Quem publica é um worker separado, DEPOIS do commit — nunca antes.
 *
 * A publicação é at-least-once: o worker pode publicar e morrer antes de marcar
 * `publishedAt`; outra instância publica de novo. Por isso o consumidor
 * deduplica pelo `eventId` (que é o `id` desta mensagem).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly eventVersion: number,
    public readonly payload: Readonly<IntegrationEventEnvelope<unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  // ------------------------------------------------------------- factories

  /** Enfileira um evento. O id da mensagem é o eventId: uma mensagem por evento. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // structuredClone: o payload gravado não pode mudar se alguém mexer no objeto original
    const payload = Object.freeze(structuredClone(event.toJSON()));
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      payload,
      new Date(event.occurredAt.getTime()),
      0,
      new Date(event.occurredAt.getTime()), // devida imediatamente
      undefined,
      undefined,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateId,
      s.eventType,
      s.eventVersion,
      Object.freeze(s.payload),
      new Date(s.occurredAt.getTime()),
      s.attempts,
      new Date(s.nextAttemptAt.getTime()),
      s.publishedAt && new Date(s.publishedAt.getTime()),
      s.lastError,
    );
  }

  // ------------------------------------------------------------- leitura

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return new Date(this._nextAttemptAt.getTime());
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt && new Date(this._publishedAt.getTime());
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e com a hora da próxima tentativa já alcançada. */
  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  // ------------------------------------------------------------- transições

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = new Date(at.getTime());
  }

  /**
   * A publicação falhou: conta a tentativa e empurra a próxima para frente.
   * `error` deve ser só a mensagem técnica (ex.: "ECONNREFUSED"), nunca o payload.
   */
  scheduleRetry(now: Date, error?: string, policy: OutboxRetryPolicy = OutboxRetryPolicy.DEFAULT): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + policy.delayMs(this._attempts));
    this._lastError = error?.slice(0, MAX_ERROR_LENGTH);
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      eventVersion: this.eventVersion,
      payload: this.payload,
      occurredAt: new Date(this.occurredAt.getTime()),
      attempts: this._attempts,
      nextAttemptAt: this.nextAttemptAt,
      publishedAt: this.publishedAt,
      lastError: this._lastError,
    };
  }

  private assertPending(): void {
    if (!this.isPending()) throw new OutboxAlreadyPublishedError(this.id);
  }
}
