import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  BusinessRuleViolationError,
  IdempotencyConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
} from '../../src/application/errors';
import type { UnitOfWork } from '../../src/application/ports/repositories';
import { systemClock, uuidV7Generator } from '../../src/application/ports/system';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
} from '../../src/application/wagering/process-wager-transaction';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerPayload,
} from '../../src/domain/wagering';
import { LedgerDirection, type Wallet } from '../../src/domain/wallet';
import { expectWalletMatchesLedger, id, openWallet, startDatabase } from './support/database';

let orm: MikroORM;
let uow: UnitOfWork;
let useCase: ProcessWagerTransaction;

beforeAll(async () => {
  ({ orm, uow } = await startDatabase());
  useCase = new ProcessWagerTransaction(uow, systemClock, uuidV7Generator);
});
afterAll(async () => {
  await orm.close(true);
});

/** Monta um comando como a API montaria. `externalTransactionId` novo a cada chamada. */
function command(
  wallet: Wallet,
  kind: Kind,
  amount: string,
  overrides: Partial<WagerPayload> = {},
): ProcessWagerTransactionCommand {
  const payload: WagerPayload = {
    providerId: 'provider-a',
    externalTransactionId: id(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
  return {
    idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
    payload,
    context: { correlationId: id() },
  };
}

async function outboxEventTypes(aggregateIds: string[]): Promise<string[]> {
  const rows = await orm.em
    .fork()
    .getConnection()
    .execute<{ event_type: string }[]>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id IN (?) ORDER BY seq`,
      [aggregateIds],
    );
  return rows.map((r) => r.event_type);
}

async function ledgerDirections(walletId: string): Promise<LedgerDirection[]> {
  const page = await uow.run((repos) => repos.ledger.listByWallet(walletId, { limit: 1000 }));
  return page.entries.map((e) => e.direction);
}

// ======================================================================== operações

describe('BET', () => {
  test('debita, grava o ledger e enfileira Processed + BalanceChanged', async () => {
    const wallet = await openWallet(uow, '100.00');
    const result = await useCase.execute(command(wallet, Kind.Bet, '25.00'));

    expect(result.status).toBe(Status.Processed);
    expect(result.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(result.idempotentReplay).toBe(false);
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('75.00');
    expect(await outboxEventTypes([result.transactionId, wallet.id])).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('sem saldo: REJECTED com INSUFFICIENT_FUNDS, saldo intacto, evento de rejeição', async () => {
    const wallet = await openWallet(uow, '10.00');
    const result = await useCase.execute(command(wallet, Kind.Bet, '25.00'));

    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('10.00');
    expect(await outboxEventTypes([result.transactionId])).toEqual(['WagerTransactionRejected']);
  });
});

describe('WIN e LOSS', () => {
  test('WIN credita', async () => {
    const wallet = await openWallet(uow, '100.00');
    const result = await useCase.execute(command(wallet, Kind.Win, '50.00'));
    expect(result.balance?.amount).toBe('150.00');
    await expectWalletMatchesLedger(uow, wallet.id);
  });

  test('LOSS registra sem mover saldo e NÃO publica WalletBalanceChanged', async () => {
    const wallet = await openWallet(uow, '100.00');
    const result = await useCase.execute(command(wallet, Kind.Loss, '0.00'));
    expect(result.status).toBe(Status.Processed);
    expect(result.balance?.amount).toBe('100.00');
    expect(await ledgerDirections(wallet.id)).toEqual([LedgerDirection.Credit]); // só a abertura
    expect(await outboxEventTypes([result.transactionId, wallet.id])).toEqual(['WagerTransactionProcessed']);
  });
});

describe('REFUND e ROLLBACK', () => {
  test('REFUND devolve a BET, uma única vez', async () => {
    const wallet = await openWallet(uow, '100.00');
    const betCmd = command(wallet, Kind.Bet, '30.00');
    await useCase.execute(betCmd);
    const ref = { referenceExternalTransactionId: betCmd.payload.externalTransactionId };

    const refund = await useCase.execute(command(wallet, Kind.Refund, '30.00', ref));
    expect(refund.status).toBe(Status.Processed);
    expect(refund.balance?.amount).toBe('100.00');

    const again = await useCase.execute(command(wallet, Kind.Refund, '30.00', ref));
    expect(again.status).toBe(Status.Rejected);
    expect(again.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('100.00');
  });

  test('ROLLBACK de um WIN debita; se negativaria, REVERSAL_WOULD_OVERDRAW (≠ INSUFFICIENT_FUNDS)', async () => {
    const wallet = await openWallet(uow, '10.00');
    const winCmd = command(wallet, Kind.Win, '50.00');
    await useCase.execute(winCmd); // 60.00
    await useCase.execute(command(wallet, Kind.Bet, '40.00')); // 20.00

    const rollback = await useCase.execute(
      command(wallet, Kind.Rollback, '50.00', { referenceExternalTransactionId: winCmd.payload.externalTransactionId }),
    );
    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('20.00');
  });

  test('REFUND antes da BET: PENDING_REFERENCE + evento', async () => {
    const wallet = await openWallet(uow, '100.00');
    const result = await useCase.execute(
      command(wallet, Kind.Refund, '30.00', { referenceExternalTransactionId: id() }),
    );
    expect(result.status).toBe(Status.PendingReference);
    expect(result.balance).toBeUndefined();
    expect(await outboxEventTypes([result.transactionId])).toEqual(['WagerTransactionPendingReference']);
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('100.00');
  });
});

describe('erros que NÃO gravam nada', () => {
  test('wallet inexistente', async () => {
    const wallet = await openWallet(uow);
    const cmd = command(wallet, Kind.Bet, '1.00', { walletId: id() });
    await expect(useCase.execute(cmd)).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('moeda diferente da wallet', async () => {
    const wallet = await openWallet(uow);
    const cmd = command(wallet, Kind.Bet, '1.00', { money: { amount: '1.00', currency: 'USD' } });
    await expect(useCase.execute(cmd)).rejects.toBeInstanceOf(BusinessRuleViolationError);
  });

  test.each([
    ['valor com 3 casas', { money: { amount: '1.005', currency: 'BRL' } }],
    ['walletId que não é UUID', { walletId: 'abc' }],
    ['REFUND sem referência', { kind: Kind.Refund }],
  ])('payload inválido: %s', async (_, override) => {
    const wallet = await openWallet(uow);
    await expect(useCase.execute(command(wallet, Kind.Bet, '1.00', override))).rejects.toBeInstanceOf(
      InvalidPayloadError,
    );
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('100.00');
  });
});

// ======================================================================== concorrência

describe('concorrência (paralelismo real contra o Postgres)', () => {
  test('CENÁRIO OBRIGATÓRIO: 100.00 e duas apostas de 80.00 simultâneas', async () => {
    const wallet = await openWallet(uow, '100.00');
    const results = await Promise.all([
      useCase.execute(command(wallet, Kind.Bet, '80.00')),
      useCase.execute(command(wallet, Kind.Bet, '80.00')),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === Status.Rejected)?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('20.00');
    // abertura (crédito) + exatamente UM débito
    expect(await ledgerDirections(wallet.id)).toEqual([LedgerDirection.Credit, LedgerDirection.Debit]);
  });

  test('20 apostas de 10.00 disputando 100.00: exatamente 10 passam, saldo 0.00', async () => {
    const wallet = await openWallet(uow, '100.00');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => useCase.execute(command(wallet, Kind.Bet, '10.00'))),
    );
    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(10);
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('0.00');
  });

  test('wallets distintas em paralelo, cada uma consistente', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(uow, '100.00')));
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 4 }, () => useCase.execute(command(w, Kind.Bet, '10.00')))),
    );
    for (const w of wallets) {
      expect((await expectWalletMatchesLedger(uow, w.id)).amount).toBe('60.00');
    }
  });
});

// ======================================================================== idempotência (desafio 4)

describe('idempotência (depende do desafio 4)', () => {
  test('mesma requisição duas vezes: replay com o resultado ORIGINAL', async () => {
    const wallet = await openWallet(uow, '100.00');
    const cmd = command(wallet, Kind.Bet, '25.00');
    const first = await useCase.execute(cmd);
    await useCase.execute(command(wallet, Kind.Bet, '5.00')); // o saldo muda depois

    const replay = await useCase.execute(cmd);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance?.amount).toBe('75.00'); // o original, não os 70.00 atuais
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('70.00');
  });

  test('mesma key com payload diferente: conflito, nada debitado', async () => {
    const wallet = await openWallet(uow, '100.00');
    const cmd = command(wallet, Kind.Bet, '25.00');
    await useCase.execute(cmd);
    const tampered = { ...cmd, payload: { ...cmd.payload, money: { amount: '99.00', currency: 'BRL' } } };
    await expect(useCase.execute(tampered)).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('75.00');
  });

  test('a MESMA aposta 50 vezes em paralelo: um único débito', async () => {
    const wallet = await openWallet(uow, '100.00');
    const cmd = command(wallet, Kind.Bet, '25.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute(cmd)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect((await expectWalletMatchesLedger(uow, wallet.id)).amount).toBe('75.00');
    expect(await ledgerDirections(wallet.id)).toEqual([LedgerDirection.Credit, LedgerDirection.Debit]);
  });
});
