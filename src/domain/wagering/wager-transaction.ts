import { Money } from "../money";
import { LedgerDirection } from "../wallet";
import { FailureCode } from "./failure-code";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "./wager-transaction-errors";
import {
  EXTERNAL_KINDS,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction-kind";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  at: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  observedBalance: Money | undefined;
  processedAt: Date | undefined;
  attempts: number;
  nextAttemptAt: Date | undefined;
}

/** Resultado da checagem de uma referência já encontrada. */
export type ReferenceCheck =
  | { outcome: "valid" }
  | { outcome: "wait" } // a referência existe, mas ainda não foi decidida
  | { outcome: "invalid"; code: FailureCode };

export const SYSTEM_PROVIDER_ID = "system";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Uma operação recebida de um provedor (ou a abertura interna da wallet).
 *
 * Responsabilidade: ciclo de vida e regras da operação.
 * NÃO move saldo: quem faz isso é a Wallet, orquestrada pelo caso de uso.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    /** saldo da wallet no momento da decisão; base da resposta de replay (regra 7.7) */
    private _observedBalance: Money | undefined,
    private _processedAt: Date | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
  ) {}

  // ------------------------------------------------------------- factories

  /** Operação externa (API/fila). Nasce em PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.validate(props);

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(props.createdAt.getTime()),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /**
   * Transação interna de abertura. Só o caso de uso CreateWallet chama isto,
   * por isso ela já nasce PROCESSED (é aplicada na mesma transação SQL que cria a wallet).
   */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        "INVALID_AMOUNT",
        "OPENING requires a positive amount",
      );
    }
    const externalId = `opening:${props.walletId}`;
    return new WagerTransaction(
      props.id,
      SYSTEM_PROVIDER_ID,
      externalId,
      `${SYSTEM_PROVIDER_ID}:${externalId}`,
      props.payloadHash,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      new Date(props.at.getTime()),
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.money,
      new Date(props.at.getTime()),
      0,
      undefined,
    );
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      new Date(s.createdAt.getTime()),
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.observedBalance,
      s.processedAt && new Date(s.processedAt.getTime()),
      s.attempts,
      s.nextAttemptAt && new Date(s.nextAttemptAt.getTime()),
    );
  }

  // ------------------------------------------------------------- getters

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt.getTime());
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt && new Date(this._nextAttemptAt.getTime());
  }

  // ------------------------------------------------------------- transições

  /** Aplicada. `observedBalance` é o saldo da wallet logo após a aplicação. */
  markProcessed(params: {
    referenceTransactionId?: string;
    observedBalance: Money;
    at: Date;
  }): void {
    this.assertNotTerminal("markProcessed");
    if (this.requiresReference() && !params.referenceTransactionId) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        "markProcessed without a resolved reference",
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = params.referenceTransactionId;
    this._observedBalance = params.observedBalance;
    this._processedAt = new Date(params.at.getTime());
    this._nextAttemptAt = undefined;
  }

  /** Referência ainda não chegou: agenda uma nova tentativa. Pode ser chamada várias vezes. */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertNotTerminal("markPendingReference");
    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        `wait for a reference (kind ${this.kind})`,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = new Date(nextAttemptAt.getTime());
  }

  /** Regra de negócio violada. `observedBalance` é opcional: nem toda rejeição olha o saldo. */
  reject(code: FailureCode, observedBalance?: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  /** Erro permanente de infraestrutura. Fica registrado para auditoria. */
  fail(code: FailureCode): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  // ------------------------------------------------------------- consultas

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  /** Mesmo hash = mesmo payload = replay. Hash diferente com a mesma key = conflito. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento que esta transação gera na wallet.
   *
   *  BET              -> DEBIT
   *  WIN, REFUND,
   *  OPENING          -> CREDIT
   *  ROLLBACK         -> o INVERSO da direção da referência
   *  LOSS             -> não gera lançamento (erro chamar)
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        // ROLLBACK desfaz a referência: vai na direção contrária a ela
        if (!reference) {
          throw new InvalidTransactionStateError(
            this.id,
            this._status,
            "resolve ledger direction for ROLLBACK",
          );
        }

        if (reference.ledgerDirectionFor() === LedgerDirection.Credit) {
          return LedgerDirection.Debit;
        } else {
          return LedgerDirection.Credit;
        }
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError(
          this.id,
          this._status,
          "resolve ledger direction for LOSS",
        );
    }
  }

  /**
   * Valida uma referência JÁ ENCONTRADA (regras 7.2, 7.3 e 7.5).
   * "Já revertida" (7.4) depende de consultar outras transações: fica no caso de uso
   * e é garantida no banco pelo índice único uq_wager_tx_single_reversal.
   */
  checkReference(reference: WagerTransaction): ReferenceCheck {
    const sameScope =
      reference.providerId === this.providerId &&
      reference.walletId === this.walletId &&
      reference.playerId === this.playerId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameScope) {
      return { outcome: "invalid", code: FailureCode.ReferenceScopeMismatch };
    }

    const allowedKinds =
      this.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ];
    if (!allowedKinds.includes(reference.kind)) {
      return { outcome: "invalid", code: FailureCode.InvalidReferenceKind };
    }

    if (!reference.isTerminal()) {
      // ex.: ROLLBACK de um REFUND que ainda está aguardando a própria referência
      return { outcome: "wait" };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: "invalid", code: FailureCode.ReferenceNotProcessed };
    }

    if (!reference.money.equals(this.money)) {
      return { outcome: "invalid", code: FailureCode.ReversalAmountMismatch };
    }

    return { outcome: "valid" };
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: new Date(this.createdAt.getTime()),
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      observedBalance: this._observedBalance,
      processedAt: this.processedAt,
      attempts: this._attempts,
      nextAttemptAt: this.nextAttemptAt,
    };
  }

  // ------------------------------------------------------------- internos

  private assertNotTerminal(attempted: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attempted);
    }
  }

  private static validate(p: CreateWagerTransactionProps): void {
    if (!EXTERNAL_KINDS.includes(p.kind)) {
      // cobre OPENING e qualquer string desconhecida
      throw new InvalidWagerTransactionError(
        "INVALID_KIND",
        `kind "${p.kind}" cannot be submitted externally`,
      );
    }

    const required: Array<[string, string]> = [
      ["providerId", p.providerId],
      ["externalTransactionId", p.externalTransactionId],
      ["idempotencyKey", p.idempotencyKey],
      ["walletId", p.walletId],
      ["playerId", p.playerId],
      ["roundId", p.roundId],
      ["gameId", p.gameId],
    ];
    for (const [field, value] of required) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new InvalidWagerTransactionError(
          "MISSING_FIELD",
          `${field} is required`,
        );
      }
    }
    if (p.providerId === SYSTEM_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(
        "RESERVED_PROVIDER",
        `providerId "${SYSTEM_PROVIDER_ID}" is reserved`,
      );
    }

    if (!SHA256_HEX.test(p.payloadHash)) {
      throw new InvalidWagerTransactionError(
        "INVALID_PAYLOAD_HASH",
        "payloadHash must be a sha256 hex digest",
      );
    }

    const needsReference =
      p.kind === WagerTransactionKind.Refund ||
      p.kind === WagerTransactionKind.Rollback;
    const hasReference =
      typeof p.referenceExternalTransactionId === "string" &&
      p.referenceExternalTransactionId.trim() !== "";
    if (needsReference && !hasReference) {
      throw new InvalidWagerTransactionError(
        "REFERENCE_REQUIRED",
        `${p.kind} requires referenceExternalTransactionId`,
      );
    }
    // WIN PODE trazer a BET como referência (seção 7), só informativa: gravada, não resolvida
    const mayHaveReference = needsReference || p.kind === WagerTransactionKind.Win;
    if (!mayHaveReference && p.referenceExternalTransactionId !== undefined) {
      throw new InvalidWagerTransactionError(
        "REFERENCE_NOT_ALLOWED",
        `${p.kind} must not have a reference`,
      );
    }
    if (
      needsReference &&
      p.referenceExternalTransactionId === p.externalTransactionId
    ) {
      throw new InvalidWagerTransactionError(
        "SELF_REFERENCE",
        "a transaction cannot reference itself",
      );
    }

    // LOSS registra o resultado sem mover saldo: aceita zero. Os demais movem saldo: valor > 0.
    if (p.kind !== WagerTransactionKind.Loss && !p.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        "INVALID_AMOUNT",
        `${p.kind} requires a positive amount`,
      );
    }
  }
}
