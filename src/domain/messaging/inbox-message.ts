import {
  InboxAlreadyProcessedError,
  InvalidInboxMessageError,
} from "./messaging-errors";

/**
 * Registro de uma mensagem recebida da SQS (Inbox, seção 6.5).
 *
 * A SQS entrega at-least-once: a mesma mensagem pode chegar de novo (redelivery).
 * A inbox é a memória PERSISTENTE do que já foi processado, com chave
 * (consumerName, messageId) — a mesma PK de `inbox_messages` no banco.
 *
 * A linha da inbox é gravada NA MESMA transação que muda o saldo: se o commit
 * acontece, a mensagem fica marcada como processada junto com o efeito;
 * se dá rollback, nenhum dos dois existe e o redelivery processa do zero.
 *
 * `matchesPayload`: messageId repetido com o MESMO conteúdo é redelivery (ack sem
 * reprocessar); com conteúdo DIFERENTE é erro permanente (vai para a DLQ).
 */

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

/** Mesmo formato do CHECK da coluna payload_hash: SHA-256 em hexadecimal minúsculo. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export class InboxMessage {
  private constructor(
    private readonly props: ReceiveInboxProps,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName) {
      throw new InvalidInboxMessageError(
        "messageId and consumerName are required",
      );
    }

    if (!SHA256_HEX.test(props.payloadHash)) {
      throw new InvalidInboxMessageError(
        "payloadHash must be 64 lowercase hex chars",
      );
    }

    return new InboxMessage(
      { ...props, receivedAt: new Date(props.receivedAt.getTime()) },
      undefined,
    );
  }

  /** Reconstrução a partir do banco. Não revalida: o estado já foi validado ao ser criado. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      {
        messageId: state.messageId,
        consumerName: state.consumerName,
        payloadHash: state.payloadHash,
        receivedAt: new Date(state.receivedAt.getTime()),
      },
      state.processedAt && new Date(state.processedAt.getTime()),
    );
  }

  get messageId(): string {
    return this.props.messageId;
  }
  get consumerName(): string {
    return this.props.consumerName;
  }
  get payloadHash(): string {
    return this.props.payloadHash;
  }
  get receivedAt(): Date {
    return new Date(this.props.receivedAt.getTime());
  }
  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt.getTime());
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InboxAlreadyProcessedError(
        this.props.consumerName,
        this.props.messageId,
      );
    }

    if (at.getTime() < this.props.receivedAt.getTime()) {
      throw new InvalidInboxMessageError(
        `processedAt (${at.toISOString()}) is before receivedAt (${this.props.receivedAt.toISOString()})`,
      );
    }

    this._processedAt = new Date(at.getTime());
  }

  matchesPayload(payloadHash: string): boolean {
    return this.props.payloadHash === payloadHash;
  }

  toState(): InboxMessageState {
    return {
      ...this.props,
      receivedAt: this.receivedAt,
      processedAt: this.processedAt,
    };
  }
}
