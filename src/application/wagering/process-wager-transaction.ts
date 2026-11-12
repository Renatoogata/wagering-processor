import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged, type EventContext, type IntegrationEvent } from '../../domain/events';
import { InboxMessage, OutboxMessage } from '../../domain/messaging';
import { Money } from '../../domain/money';
import {
  FailureCode,
  ReferenceRetryPolicy,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  hashInboxContent,
  hashWagerPayload,
  type WagerPayload,
} from '../../domain/wagering';
import { LedgerDirection, type Wallet, type WalletLedgerEntry } from '../../domain/wallet';
import {
  BusinessRuleViolationError,
  DuplicateExternalTransactionError,
  InboxMessageConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
} from '../errors';
import { ConcurrentWriteConflictError, type TransactionalRepositories, type UnitOfWork } from '../ports/repositories';
import type { Clock, IdGenerator } from '../ports/system';
import { assertUuid, translateValidationError } from '../validation';
import { replayOrConflict, toResult, type WagerTransactionResult } from './wager-transaction-result';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  payload: WagerPayload;
  /** rastreabilidade: vai para os eventos da outbox */
  context: { correlationId: string; causationId?: string };
  /** presente quando a entrada é a SQS: a inbox é gravada na MESMA transação */
  inbox?: { consumerName: string; messageId: string };
}

/** Quantas vezes repetir quando duas transações concorrentes colidem numa constraint única. */
const MAX_CONFLICT_RETRIES = 3;

/**
 * Caso de uso central: processa uma operação do provedor (BET, WIN, LOSS, REFUND, ROLLBACK).
 * É o MESMO para HTTP e SQS (seção 10).
 *
 * Tudo acontece numa única transação SQL, nesta ordem:
 *   1. trava a wallet (SELECT ... FOR UPDATE)            ← fila por wallet
 *   2. dedup: a mensagem (inbox) ou a key já existem?    ← DEPOIS do lock (ver abaixo)
 *   3. decide: aplica, rejeita ou deixa pendente
 *   4. grava transação, saldo, ledger, eventos (outbox) e inbox
 *   5. commit — só então a resposta sai
 *
 * Por que checar a idempotência DEPOIS do lock?
 * Se fosse antes, duas cópias simultâneas da mesma BET leriam "não existe" ao mesmo
 * tempo e as duas tentariam debitar. Depois do lock, a segunda só roda quando a
 * primeira já commitou — e então ENXERGA a transação gravada e vira replay.
 * E se as cópias apontarem wallets diferentes (payload adulterado)? Não há lock
 * em comum; a constraint UNIQUE da key barra a segunda, a transação é desfeita
 * (ConcurrentWriteConflictError) e a nova tentativa cai no caminho de conflito.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly referencePolicy: ReferenceRetryPolicy = new ReferenceRetryPolicy(),
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<WagerTransactionResult> {
    const { money, payloadHash } = this.validate(command);
    return this.inTransaction((repos) => this.process(repos, command, money, payloadHash));
  }

  /**
   * Nova tentativa de uma transação PENDING_REFERENCE (chamado pelo worker, seção 7.1).
   * Usa EXATAMENTE a mesma regra de reversão do caminho principal (`decideReversal`).
   *
   * Resultado:
   *  - referência chegou e é válida → PROCESSED, saldo e ledger mudam, eventos na outbox;
   *  - referência chegou e é inválida → REJECTED com o código da regra;
   *  - ainda não chegou → continua PENDING_REFERENCE com o próximo horário (backoff);
   *  - limite de tentativas → REJECTED REFERENCE_NOT_FOUND + WagerTransactionRejected.
   *
   * Devolve `undefined` quando não havia nada a fazer: outra instância já resolveu,
   * ou a tentativa ainda não venceu. Por isso dois workers na mesma transação são seguros.
   */
  async resolvePendingReference(transactionId: string, walletId: string): Promise<WagerTransactionResult | undefined> {
    return this.inTransaction(async (repos) => {
      const now = this.clock.now();

      // 1. lock da wallet ANTES da transação: mesma ordem do execute() → sem deadlock
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      if (!wallet) return undefined;

      // 2. relê a transação com a wallet travada: outra instância pode ter resolvido enquanto esperávamos
      const tx = await repos.transactions.findByIdForUpdate(transactionId);
      if (!tx || tx.status !== Status.PendingReference) return undefined;
      if (tx.nextAttemptAt && tx.nextAttemptAt.getTime() > now.getTime()) return undefined;

      // 3. mesma decisão do caminho principal
      const entry = await this.decideReversal(repos, tx, wallet, now);

      // 4. grava (transação já existe: update; depois saldo e ledger)
      await repos.transactions.update(tx);
      if (entry) {
        await repos.wallets.update(wallet);
        await repos.ledger.append(entry);
      }
      // eventos só no desfecho: "ainda pendente" de novo não interessa a ninguém
      if (tx.status !== Status.PendingReference) {
        // a transação não guarda o correlationId da chamada original: o id dela liga os eventos
        const context = { correlationId: tx.id, causationId: tx.id };
        for (const event of this.eventsFor(tx, wallet, entry, context, now)) {
          await repos.outbox.add(OutboxMessage.enqueue(event));
        }
      }
      return toResult(tx, false);
    });
  }

  /** Roda numa transação e repete quando duas transações concorrentes colidem numa constraint única. */
  private async inTransaction<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run(work);
      } catch (error) {
        if (error instanceof ConcurrentWriteConflictError && attempt < MAX_CONFLICT_RETRIES) continue;
        throw translateValidationError(error);
      }
    }
  }

  // ------------------------------------------------------------- dentro da transação

  private async process(
    repos: TransactionalRepositories,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<WagerTransactionResult> {
    const { payload } = command;
    const now = this.clock.now();

    // 1. lock da wallet
    const wallet = await repos.wallets.findByIdForUpdate(payload.walletId);
    if (!wallet) throw new WalletNotFoundError(payload.walletId);

    // 2a. inbox (só SQS): esta MENSAGEM já foi processada? redelivery → devolve o original
    const redelivered = await this.checkInbox(repos, command, payloadHash);
    if (redelivered) return redelivered;

    // 2b. idempotência (persistente: consulta o banco, nunca memória)
    const existing = await repos.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      const result = replayOrConflict(existing, payloadHash);
      await this.recordInbox(repos, command, payloadHash, now);
      return result;
    }

    // mesmo (provider, externalId) com OUTRA key: não é replay nem operação nova.
    // Sem este check, o UNIQUE do banco estouraria e o retry repetiria o erro 3x.
    const sameExternal = await repos.transactions.findByProviderAndExternalId(
      payload.providerId,
      payload.externalTransactionId,
    );
    if (sameExternal) {
      throw new DuplicateExternalTransactionError(payload.providerId, payload.externalTransactionId);
    }

    // moeda diferente da wallet: a FK (wallet_id, currency) impede gravar como REJECTED
    if (money.currency !== wallet.currency) {
      throw new BusinessRuleViolationError(
        FailureCode.CurrencyMismatch,
        `wallet ${wallet.id} is ${wallet.currency}, operation is ${money.currency}`,
      );
    }

    // 3. decide
    const tx = WagerTransaction.create({
      ...payload,
      id: this.ids.next(),
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      money,
      createdAt: now,
    });

    let entry: WalletLedgerEntry | undefined;
    if (wallet.playerId !== tx.playerId) {
      tx.reject(FailureCode.WalletPlayerMismatch);
    } else {
      entry = await this.decide(repos, tx, wallet, now);
    }

    // 4. grava (a ordem respeita as FKs: transação -> saldo -> ledger)
    await repos.transactions.insert(tx);
    if (entry) {
      await repos.wallets.update(wallet);
      await repos.ledger.append(entry);
    }
    for (const event of this.eventsFor(tx, wallet, entry, command.context, now)) {
      await repos.outbox.add(OutboxMessage.enqueue(event));
    }
    await this.recordInbox(repos, command, payloadHash, now);

    return toResult(tx, false);
  }

  /**
   * Aplica as regras do tipo de operação. Muda o estado de `tx` (PROCESSED, REJECTED
   * ou PENDING_REFERENCE) e, quando o saldo muda, devolve o lançamento do ledger.
   */
  private async decide(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    switch (tx.kind) {
      case Kind.Bet:
        if (!wallet.canAfford(tx.money)) {
          tx.reject(FailureCode.InsufficientFunds, wallet.balance);
          return undefined;
        }
        return this.move(tx, wallet, LedgerDirection.Debit, now);

      case Kind.Win:
        return this.move(tx, wallet, LedgerDirection.Credit, now);

      case Kind.Loss:
        // registra o resultado da rodada sem mover saldo
        tx.markProcessed({ observedBalance: wallet.balance, at: now });
        return undefined;

      case Kind.Refund:
      case Kind.Rollback:
        return this.decideReversal(repos, tx, wallet, now);

      default:
        throw new InvalidPayloadError('INVALID_KIND', `kind ${tx.kind} cannot be processed`);
    }
  }

  private async decideReversal(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    const reference = await repos.transactions.findByProviderAndExternalId(
      tx.providerId,
      tx.referenceExternalTransactionId!,
    );

    // referência ainda não chegou (ou ainda não foi decidida): aguarda o worker (seção 7.1)
    const check = reference ? tx.checkReference(reference) : { outcome: 'wait' as const };
    if (check.outcome === 'wait') {
      const next = this.referencePolicy.nextAttemptAt(tx.attempts, now);
      if (next) tx.markPendingReference(next);
      else tx.reject(FailureCode.ReferenceNotFound);
      return undefined;
    }
    if (check.outcome === 'invalid') {
      tx.reject(check.code);
      return undefined;
    }

    const ref = reference!;
    // regra 7.4: uma referência só é revertida uma vez por tipo de operação
    // (o índice único parcial no banco garante o mesmo, como última defesa)
    if (await repos.transactions.hasProcessedReversal(ref.id, tx.kind)) {
      tx.reject(FailureCode.ReferenceAlreadyReversed);
      return undefined;
    }

    const direction = tx.ledgerDirectionFor(ref);
    // regra 7.9: reversão que negativaria o saldo tem código PRÓPRIO, diferente de BET sem saldo
    if (direction === LedgerDirection.Debit && !wallet.canAfford(tx.money)) {
      tx.reject(FailureCode.ReversalWouldOverdraw, wallet.balance);
      return undefined;
    }
    return this.move(tx, wallet, direction, now, ref.id);
  }

  /** Move o saldo e marca a transação como PROCESSED com o saldo resultante. */
  private move(
    tx: WagerTransaction,
    wallet: Wallet,
    direction: LedgerDirection,
    now: Date,
    referenceTransactionId?: string,
  ): WalletLedgerEntry {
    const movement = { entryId: this.ids.next(), transactionId: tx.id, money: tx.money, at: now };
    const entry = direction === LedgerDirection.Credit ? wallet.credit(movement) : wallet.debit(movement);
    tx.markProcessed({
      ...(referenceTransactionId && { referenceTransactionId }),
      observedBalance: wallet.balance,
      at: now,
    });
    return entry;
  }

  // ------------------------------------------------------------- eventos e inbox

  private eventsFor(
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    context: ProcessWagerTransactionCommand['context'],
    now: Date,
  ): IntegrationEvent<unknown>[] {
    const ctx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: context.correlationId,
      ...(context.causationId !== undefined && { causationId: context.causationId }),
      occurredAt: now,
    });

    switch (tx.status) {
      case Status.Processed:
        return [
          WagerTransactionProcessed.from(tx, ctx()),
          ...(entry ? [WalletBalanceChanged.from(wallet, entry, ctx())] : []),
        ];
      case Status.Rejected:
        return [WagerTransactionRejected.from(tx, ctx())];
      case Status.PendingReference:
        return [WagerTransactionPendingReference.from(tx, ctx())];
      default:
        return [];
    }
  }

  /**
   * Redelivery da SQS: o mesmo (consumerName, messageId) já está na inbox.
   *  - mesmo conteúdo → devolve o resultado original como replay (nenhum efeito novo);
   *  - conteúdo diferente → InboxMessageConflictError (vai para a DLQ).
   * Roda com a wallet travada: duas cópias da mesma mensagem fazem fila no lock, e a
   * segunda já enxerga a inbox gravada pela primeira.
   */
  private async checkInbox(
    repos: TransactionalRepositories,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<WagerTransactionResult | undefined> {
    if (!command.inbox) return undefined;
    const seen = await repos.inbox.find(command.inbox.consumerName, command.inbox.messageId);
    if (!seen) return undefined;

    if (!seen.matchesPayload(hashInboxContent(command.idempotencyKey, payloadHash))) {
      throw new InboxMessageConflictError(command.inbox.consumerName, command.inbox.messageId);
    }
    // inbox e transação são gravadas no mesmo commit: se uma existe, a outra também
    const original = await repos.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (!original) throw new Error(`inbox ${command.inbox.messageId} has no transaction (broken invariant)`);
    return toResult(original, true);
  }

  private async recordInbox(
    repos: TransactionalRepositories,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    now: Date,
  ): Promise<void> {
    if (!command.inbox) return;
    // checkInbox já garantiu que a mensagem é nova; se outra instância gravar a mesma
    // mensagem em paralelo (outra wallet = outro lock), a PK da inbox barra no commit
    const message = InboxMessage.receive({
      ...command.inbox,
      payloadHash: hashInboxContent(command.idempotencyKey, payloadHash),
      receivedAt: now,
    });
    message.markProcessed(now);
    await repos.inbox.insert(message);
  }

  // ------------------------------------------------------------- validação de entrada

  /** Falhas aqui viram "payload inválido": nada é gravado e reenviar igual nunca vai funcionar. */
  private validate(command: ProcessWagerTransactionCommand): { money: Money; payloadHash: string } {
    const { payload } = command;
    if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.length < 1 || command.idempotencyKey.length > 512) {
      throw new InvalidPayloadError('INVALID_IDEMPOTENCY_KEY', 'idempotency key must have 1 to 512 characters');
    }
    assertUuid('walletId', payload.walletId);
    assertUuid('playerId', payload.playerId);
    try {
      const money = Money.from(payload.money);
      return { money, payloadHash: hashWagerPayload(payload) };
    } catch (error) {
      throw translateValidationError(error);
    }
  }
}
