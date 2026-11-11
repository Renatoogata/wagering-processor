import { DomainError } from '../shared/domain-error';

/** Tentativa de publicar/reagendar uma mensagem da outbox que já foi publicada. Indica bug. */
export class OutboxAlreadyPublishedError extends DomainError {
  readonly code = 'OUTBOX_ALREADY_PUBLISHED';

  constructor(readonly outboxId: string) {
    super(`Outbox message ${outboxId} was already published`);
  }
}

/** Dados inválidos ao registrar uma mensagem recebida. */
export class InvalidInboxMessageError extends DomainError {
  readonly code = 'INVALID_INBOX_MESSAGE';

  constructor(reason: string) {
    super(`Invalid inbox message: ${reason}`);
  }
}

/** Tentativa de marcar como processada uma mensagem que já foi processada. */
export class InboxAlreadyProcessedError extends DomainError {
  readonly code = 'INBOX_ALREADY_PROCESSED';

  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super(`Inbox message ${consumerName}/${messageId} was already processed`);
  }
}
