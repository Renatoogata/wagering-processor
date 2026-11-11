import { DomainError } from '../shared/domain-error';

/**
 * Contexto de quem está emitindo o evento.
 *
 * Os valores vêm de fora (IdGenerator, Clock, request/mensagem de entrada),
 * o que mantém o domínio determinístico e testável — mesmo padrão da Wallet.
 *
 *  - correlationId: o "fio" que liga tudo o que nasceu do mesmo pedido do provedor
 *    (a requisição HTTP ou a mensagem SQS). Todos os eventos de um mesmo
 *    processamento compartilham o mesmo correlationId.
 *  - causationId: o que causou ESTE evento (ex.: o messageId da SQS).
 */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

/** Formato serializado, gravado na coluna `payload` da outbox e publicado. */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/**
 * Envelope de um evento de integração (seção 11).
 *
 * Por que classe abstrata e não um objeto literal `{ type: 'X', ... }`:
 *  - `eventType` e `version` ficam NO TIPO (cada subclasse declara os seus),
 *    então não existe string solta no call site que alguém possa digitar errado;
 *  - cada subclasse tem uma factory `from(...)` que só aceita a fonte certa
 *    (ex.: WagerTransactionProcessed só nasce de uma transação PROCESSED).
 *
 * `data` é sempre JSON puro (MoneyProps com string decimal, datas em ISO),
 * nunca instâncias de domínio: o payload precisa ser estável e versionável.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt.getTime()); // cópia defensiva
    this.data = Object.freeze({ ...props.data });
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined && { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

/**
 * Tentativa de criar um evento a partir de um estado que não o justifica
 * (ex.: "Processed" para uma transação REJECTED). Indica bug no caso de uso.
 */
export class InvalidEventSourceError extends DomainError {
  readonly code = 'INVALID_EVENT_SOURCE';

  constructor(eventType: string, reason: string) {
    super(`Cannot create ${eventType}: ${reason}`);
  }
}
