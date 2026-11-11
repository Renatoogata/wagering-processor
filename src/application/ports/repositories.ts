import type { InboxMessage, OutboxMessage } from '../../domain/messaging';
import type { Money } from '../../domain/money';
import type { WagerTransaction, WagerTransactionKind } from '../../domain/wagering';
import type { Wallet, WalletLedgerEntry } from '../../domain/wallet';

/**
 * Portas de persistência (arquitetura hexagonal).
 *
 * O caso de uso só conhece ESTAS interfaces, nunca o MikroORM. Isso deixa:
 *  - o domínio e a aplicação sem dependência de ORM;
 *  - a troca de tecnologia de banco restrita à pasta infrastructure/;
 *  - claro, no tipo, o que cada operação promete (ex.: "ForUpdate" = trava a linha).
 */

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;

  /**
   * Lê a wallet TRAVANDO a linha (SELECT ... FOR UPDATE) até o fim da transação.
   * É a base do controle de concorrência: duas instâncias que querem mexer na mesma
   * wallet fazem fila aqui; wallets diferentes não se bloqueiam (lock por linha, não global).
   */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;

  /** Regra "uma wallet por player + moeda" (o UNIQUE do banco é a última defesa). */
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;

  insert(wallet: Wallet): Promise<void>;

  /** Grava saldo/version/updatedAt. Só deve ser chamado com a linha travada. */
  update(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Já existe uma reversão PROCESSED deste tipo para esta referência? (regra 7.4) */
  hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
  insert(tx: WagerTransaction): Promise<void>;
  /** Grava as transições de estado (status, failureCode, observedBalance, attempts...). */
  update(tx: WagerTransaction): Promise<void>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** posição do último item devolvido; `undefined` quando não há mais páginas */
  nextAfterSeq: string | undefined;
}

export interface LedgerRepository {
  /** Append-only: não existe update nem delete (o banco também proíbe). */
  append(entry: WalletLedgerEntry): Promise<void>;

  /** Página do ledger em ordem de gravação. `afterSeq` é a posição exclusiva de início. */
  listByWallet(walletId: string, options: { afterSeq?: string; limit: number }): Promise<LedgerPage>;

  /** Saldo reconstruído a partir do ledger (créditos - débitos) e quantos lançamentos foram somados. */
  calculateBalance(walletId: string, currency: string): Promise<{ balance: Money; entries: number }>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  insert(message: InboxMessage): Promise<void>;
  update(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
}

/** Todos os repositórios presos à MESMA transação SQL. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Unit of Work: executa `work` dentro de UMA transação SQL.
 *
 * Tudo o que os repositórios recebidos gravarem é confirmado junto (commit)
 * ou desfeito junto (rollback, se `work` lançar). É isso que garante a
 * atomicidade exigida: transação + saldo + ledger + inbox + outbox.
 */
export interface UnitOfWork {
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/**
 * Duas transações concorrentes tentaram gravar a mesma coisa única
 * (ex.: a mesma idempotency key) ou entraram em deadlock.
 * A transação inteira foi desfeita; repetir a operação é seguro e,
 * na segunda vez, ela enxerga o que a outra gravou (vira replay ou conflito).
 */
export class ConcurrentWriteConflictError extends Error {
  constructor(override readonly cause: unknown) {
    super('Concurrent write conflict; the unit of work was rolled back');
    this.name = 'ConcurrentWriteConflictError';
  }
}

/**
 * Falha de infraestrutura que pode passar sozinha (banco fora do ar, conexão caiu,
 * timeout esperando lock). A operação NÃO foi aplicada (rollback) e reenviar é seguro:
 * a idempotência garante que, se por acaso tiver sido, o reenvio vira replay.
 */
export class TransientInfrastructureError extends Error {
  constructor(override readonly cause: unknown) {
    super('Transient infrastructure failure; the operation was not applied and may be retried');
    this.name = 'TransientInfrastructureError';
  }
}
