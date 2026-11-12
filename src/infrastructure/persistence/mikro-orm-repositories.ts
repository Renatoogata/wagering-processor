import {
  ConnectionException,
  DeadlockException,
  LockMode,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  ConcurrentWriteConflictError,
  TransientInfrastructureError,
  type InboxRepository,
  type LedgerPage,
  type LedgerRepository,
  type OutboxRepository,
  type TransactionalRepositories,
  type UnitOfWork,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../../application/ports/repositories';
import type { InboxMessage, OutboxMessage } from '../../domain/messaging';
import { Money } from '../../domain/money';
import { WagerTransactionStatus, type WagerTransaction, type WagerTransactionKind } from '../../domain/wagering';
import type { Wallet, WalletLedgerEntry } from '../../domain/wallet';
import {
  InboxMessageRow,
  LedgerEntryRow,
  OutboxMessageRow,
  WagerTransactionRow,
  WalletRow,
} from './entities';
import {
  inboxToDomain,
  inboxToRow,
  ledgerEntryToDomain,
  ledgerEntryToRow,
  outboxToDomain,
  outboxToRow,
  transactionToDomain,
  transactionToRow,
  walletToDomain,
  walletToRow,
} from './mappers';

/**
 * Implementações MikroORM das portas.
 *
 * Toda escrita faz `flush()` na hora. Por quê, se o MikroORM sabe agrupar tudo
 * num flush só no commit? Porque as FKs são compostas e não estão declaradas
 * como relações no ORM: ele não saberia a ordem certa dos INSERTs
 * (wallet -> transação -> ledger). Com flush por escrita, a ordem é a do caso de uso,
 * explícita. Tudo continua dentro da MESMA transação SQL: nada é confirmado antes do commit.
 */

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRow, { id });
    return row ? walletToDomain(row) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    // SELECT ... FOR UPDATE: a linha fica travada até o commit/rollback.
    // Outra transação que pedir o mesmo lock ESPERA; depois lê o saldo já atualizado.
    const row = await this.em.findOne(WalletRow, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return row ? walletToDomain(row) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRow, { playerId, currency });
    return row ? walletToDomain(row) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    this.em.create(WalletRow, walletToRow(wallet));
    await this.em.flush();
  }

  async update(wallet: Wallet): Promise<void> {
    const row = await this.em.findOneOrFail(WalletRow, { id: wallet.id });
    this.em.assign(row, walletToRow(wallet));
    await this.em.flush();
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ id });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ idempotencyKey });
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRow, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    this.em.create(WagerTransactionRow, transactionToRow(tx, tx.createdAt));
    await this.em.flush();
  }

  async update(tx: WagerTransaction): Promise<void> {
    const row = await this.em.findOneOrFail(WagerTransactionRow, { id: tx.id });
    this.em.assign(row, transactionToRow(tx, new Date()));
    await this.em.flush();
  }

  private async findOneBy(where: Partial<WagerTransactionRow>): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRow, where);
    return row ? transactionToDomain(row) : undefined;
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    this.em.create(LedgerEntryRow, ledgerEntryToRow(entry) as LedgerEntryRow);
    await this.em.flush();
  }

  async listByWallet(walletId: string, options: { afterSeq?: string; limit: number }): Promise<LedgerPage> {
    const rows = await this.em.find(
      LedgerEntryRow,
      { walletId, ...(options.afterSeq !== undefined && { seq: { $gt: BigInt(options.afterSeq) } }) },
      // pede 1 a mais só para saber se existe próxima página
      { orderBy: { seq: 'asc' }, limit: options.limit + 1 },
    );
    const page = rows.slice(0, options.limit);
    const hasMore = rows.length > options.limit;
    return {
      entries: page.map(ledgerEntryToDomain),
      nextAfterSeq: hasMore ? page[page.length - 1]?.seq.toString() : undefined,
    };
  }

  async calculateBalance(walletId: string, currency: string): Promise<{ balance: Money; entries: number }> {
    // A soma é feita no banco, em NUMERIC (exato). round(..., 2)::text garante "0.00" e não "0".
    const [result] = await this.em.getConnection().execute<{ balance: string; entries: number }[]>(
      `SELECT round(coalesce(sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0), 2)::text AS balance,
              count(*)::int AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    return { balance: Money.from({ amount: result!.balance, currency }), entries: result!.entries };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(InboxMessageRow, { consumerName, messageId });
    return row ? inboxToDomain(row) : undefined;
  }

  async insert(message: InboxMessage): Promise<void> {
    this.em.create(InboxMessageRow, inboxToRow(message));
    await this.em.flush();
  }

  async update(message: InboxMessage): Promise<void> {
    const row = await this.em.findOneOrFail(InboxMessageRow, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    this.em.assign(row, inboxToRow(message));
    await this.em.flush();
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    this.em.create(OutboxMessageRow, outboxToRow(message) as OutboxMessageRow);
    await this.em.flush();
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // usa o índice parcial ix_outbox_pending (next_attempt_at, seq) WHERE published_at IS NULL
    const rows = await this.em.find(
      OutboxMessageRow,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { seq: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, refresh: true },
    );
    return rows.map(outboxToDomain);
  }

  async update(message: OutboxMessage): Promise<void> {
    const row = await this.em.findOneOrFail(OutboxMessageRow, { id: message.id });
    const s = outboxToRow(message);
    this.em.assign(row, {
      attempts: s.attempts,
      nextAttemptAt: s.nextAttemptAt,
      publishedAt: s.publishedAt,
      lastError: s.lastError,
    });
    await this.em.flush();
  }
}

export function createRepositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

/**
 * Cada `run` usa um EntityManager NOVO (fork): identity map isolado por operação,
 * sem vazar entidades entre requisições concorrentes.
 *
 * Isolamento: READ COMMITTED (padrão do Postgres). Basta, porque a disputa pela
 * wallet é resolvida com SELECT ... FOR UPDATE, e as unicidades (idempotency key,
 * reversão única, versão do ledger) são garantidas por constraints.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional((em) => work(createRepositories(em)));
    } catch (error) {
      // traduz o erro do ORM para o vocabulário da aplicação (que não conhece MikroORM)
      if (error instanceof UniqueConstraintViolationException || error instanceof DeadlockException) {
        throw new ConcurrentWriteConflictError(error);
      }
      if (isTransient(error)) throw new TransientInfrastructureError(error);
      throw error;
    }
  }
}

const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '53300']);

/** Conexão/lock que pode se resolver sozinho. Erros de lógica e de constraint NÃO entram aqui. */
function isTransient(error: unknown): boolean {
  if (error instanceof ConnectionException || error instanceof LockWaitTimeoutException) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code);
}
