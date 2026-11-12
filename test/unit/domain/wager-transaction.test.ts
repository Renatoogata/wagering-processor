import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money';
import { LedgerDirection } from '../../../src/domain/wallet';
import {
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../../src/domain/wagering';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const HASH = 'a'.repeat(64);
const T0 = new Date('2026-11-10T12:00:00Z');
const T1 = new Date('2026-11-10T12:00:05Z');

let seq = 0;
function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const n = ++seq;
  return {
    id: `tx-${n}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `provider-a:ext-${n}`,
    payloadHash: HASH,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: T0,
    ...overrides,
  };
}

const tx = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(overrides));

/** Uma transação já aplicada, para servir de referência. */
function processed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const t = tx(overrides);
  t.markProcessed({
    // reversões só podem ser PROCESSED com a referência resolvida
    referenceTransactionId: t.requiresReference() ? 'tx-resolved-reference' : undefined,
    observedBalance: brl('100.00'),
    at: T0,
  });
  return t;
}

const reversal = (kind: Kind.Refund | Kind.Rollback, reference: WagerTransaction, overrides = {}) =>
  tx({ kind, referenceExternalTransactionId: reference.externalTransactionId, money: reference.money, ...overrides });

// =========================================================================== create

describe('WagerTransaction.create', () => {
  test('nasce em PENDING, sem tentativas nem desfecho', () => {
    const t = tx();
    expect(t.status).toBe(Status.Pending);
    expect(t.attempts).toBe(0);
    expect(t.failureCode).toBeUndefined();
    expect(t.processedAt).toBeUndefined();
    expect(t.isTerminal()).toBe(false);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])('%s sem referência é aceito', (kind) => {
    expect(tx({ kind }).kind).toBe(kind);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s com referência é aceito', (kind) => {
    expect(tx({ kind, referenceExternalTransactionId: 'ext-original' }).requiresReference()).toBe(true);
  });

  test('WIN pode trazer a BET como referência (informativa, seção 7)', () => {
    const win = tx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' });
    expect(win.referenceExternalTransactionId).toBe('bet-1');
    expect(win.requiresReference()).toBe(false);
  });

  test('LOSS aceita valor zero (registra resultado, não move saldo)', () => {
    expect(tx({ kind: Kind.Loss, money: brl('0.00') }).money.isZero()).toBe(true);
  });

  const invalid: Array<[string, Partial<CreateWagerTransactionProps>, string]> = [
    ['OPENING vindo de fora', { kind: Kind.Opening }, 'INVALID_KIND'],
    ['kind desconhecido', { kind: 'JACKPOT' as Kind }, 'INVALID_KIND'],
    ['REFUND sem referência', { kind: Kind.Refund }, 'REFERENCE_REQUIRED'],
    ['ROLLBACK com referência vazia', { kind: Kind.Rollback, referenceExternalTransactionId: '  ' }, 'REFERENCE_REQUIRED'],
    ['BET com referência', { referenceExternalTransactionId: 'ext-x' }, 'REFERENCE_NOT_ALLOWED'],
    ['LOSS com referência', { kind: Kind.Loss, money: brl('0.00'), referenceExternalTransactionId: 'ext-x' }, 'REFERENCE_NOT_ALLOWED'],
    [
      'referência a si mesma',
      { kind: Kind.Refund, externalTransactionId: 'same', referenceExternalTransactionId: 'same' },
      'SELF_REFERENCE',
    ],
    ['BET com valor zero', { money: brl('0.00') }, 'INVALID_AMOUNT'],
    ['WIN com valor zero', { kind: Kind.Win, money: brl('0.00') }, 'INVALID_AMOUNT'],
    ['providerId vazio', { providerId: '' }, 'MISSING_FIELD'],
    ['roundId vazio', { roundId: ' ' }, 'MISSING_FIELD'],
    ['gameId ausente', { gameId: undefined as unknown as string }, 'MISSING_FIELD'],
    ['provider reservado "system"', { providerId: 'system' }, 'RESERVED_PROVIDER'],
    ['payloadHash inválido', { payloadHash: 'abc' }, 'INVALID_PAYLOAD_HASH'],
  ];
  test.each(invalid)('rejeita %s', (_label, overrides, code) => {
    expect(() => tx(overrides)).toThrow(InvalidWagerTransactionError);
    expect(() => tx(overrides)).toThrow(expect.objectContaining({ code }));
  });
});

describe('WagerTransaction.createOpening', () => {
  test('nasce PROCESSED, interna, com saldo observado igual ao valor', () => {
    const t = WagerTransaction.createOpening({
      id: 'tx-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      payloadHash: HASH,
      at: T0,
    });
    expect(t.kind).toBe(Kind.Opening);
    expect(t.status).toBe(Status.Processed);
    expect(t.providerId).toBe('system');
    expect(t.idempotencyKey).toBe('system:opening:wallet-1');
    expect(t.observedBalance?.amount).toBe('1000.00');
    expect(t.roundId).toBeUndefined();
    expect(t.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('rejeita valor zero', () => {
    expect(() =>
      WagerTransaction.createOpening({
        id: 'x',
        walletId: 'w',
        playerId: 'p',
        money: brl('0.00'),
        payloadHash: HASH,
        at: T0,
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

// =========================================================================== transições

describe('WagerTransaction: transições válidas', () => {
  test('PENDING -> PROCESSED guarda saldo observado e data', () => {
    const t = tx();
    t.markProcessed({ observedBalance: brl('975.00'), at: T1 });
    expect(t.status).toBe(Status.Processed);
    expect(t.observedBalance?.amount).toBe('975.00');
    expect(t.processedAt).toEqual(T1);
    expect(t.isTerminal()).toBe(true);
  });

  test('PENDING -> REJECTED guarda o failureCode', () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds, brl('20.00'));
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(t.observedBalance?.amount).toBe('20.00');
  });

  test('PENDING -> FAILED', () => {
    const t = tx();
    t.fail(FailureCode.ProcessingFailed);
    expect(t.status).toBe(Status.Failed);
    expect(t.failureCode).toBe(FailureCode.ProcessingFailed);
  });

  test('PENDING -> PENDING_REFERENCE -> PENDING_REFERENCE -> PROCESSED', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });

    t.markPendingReference(T1);
    expect(t.status).toBe(Status.PendingReference);
    expect(t.attempts).toBe(1);
    expect(t.nextAttemptAt).toEqual(T1);

    t.markPendingReference(new Date(T1.getTime() + 2000));
    expect(t.attempts).toBe(2);

    t.markProcessed({ referenceTransactionId: 'tx-bet', observedBalance: brl('100.00'), at: T1 });
    expect(t.status).toBe(Status.Processed);
    expect(t.referenceTransactionId).toBe('tx-bet');
    expect(t.nextAttemptAt).toBeUndefined();
  });

  test('PENDING_REFERENCE -> REJECTED quando a referência nunca chega', () => {
    const t = tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-bet' });
    t.markPendingReference(T1);
    t.reject(FailureCode.ReferenceNotFound);
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
  });
});

describe('WagerTransaction: estados terminais são finais', () => {
  const terminal: Array<[string, () => WagerTransaction]> = [
    ['PROCESSED', () => processed()],
    [
      'REJECTED',
      () => {
        const t = tx();
        t.reject(FailureCode.InsufficientFunds);
        return t;
      },
    ],
    [
      'FAILED',
      () => {
        const t = tx();
        t.fail(FailureCode.ProcessingFailed);
        return t;
      },
    ],
  ];

  describe.each(terminal)('a partir de %s', (_label, make) => {
    test('markProcessed lança', () => {
      expect(() => make().markProcessed({ observedBalance: brl('1.00'), at: T1 })).toThrow(
        InvalidTransactionStateError,
      );
    });
    test('reject lança', () => {
      expect(() => make().reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    });
    test('fail lança', () => {
      expect(() => make().fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);
    });
    test('o estado não muda depois da tentativa', () => {
      const t = make();
      const before = t.toState();
      try {
        t.reject(FailureCode.ReferenceNotFound);
      } catch {
        /* esperado */
      }
      expect(t.toState()).toEqual(before);
    });
  });
});

describe('WagerTransaction: transições inválidas por kind', () => {
  test('BET não pode aguardar referência', () => {
    expect(() => tx().markPendingReference(T1)).toThrow(InvalidTransactionStateError);
  });

  test('REFUND não pode ser PROCESSED sem a referência resolvida', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    expect(() => t.markProcessed({ observedBalance: brl('1.00'), at: T1 })).toThrow(InvalidTransactionStateError);
    expect(t.status).toBe(Status.Pending);
  });
});

// =========================================================================== consultas

describe('WagerTransaction: consultas', () => {
  test('affectsBalance é false só para LOSS', () => {
    expect(tx({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    expect(tx({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(tx({ kind: Kind.Win }).affectsBalance()).toBe(true);
  });

  test('requiresReference só para REFUND e ROLLBACK', () => {
    expect(tx().requiresReference()).toBe(false);
    expect(tx({ kind: Kind.Refund, referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
  });

  test('matchesPayload: mesmo hash é replay, hash diferente é conflito', () => {
    const t = tx();
    expect(t.matchesPayload(HASH)).toBe(true);
    expect(t.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  test('BET debita', () => {
    expect(tx({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  test('WIN credita', () => {
    expect(tx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('REFUND credita (devolve a aposta)', () => {
    const bet = processed();
    expect(reversal(Kind.Refund, bet).ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK de BET credita (desfaz um débito)', () => {
    const bet = processed({ kind: Kind.Bet });
    expect(reversal(Kind.Rollback, bet).ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK de WIN debita (desfaz um crédito)', () => {
    const win = processed({ kind: Kind.Win });
    expect(reversal(Kind.Rollback, win).ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK de REFUND debita (desfaz a devolução)', () => {
    const refund = processed({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    expect(reversal(Kind.Rollback, refund).ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referência lança', () => {
    const rb = tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-x' });
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('LOSS não tem direção: chamar é erro de programação', () => {
    expect(() => tx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });
});

// =========================================================================== referências

describe('WagerTransaction.checkReference', () => {
  test('REFUND de BET processada com mesmo valor é válido', () => {
    const bet = processed();
    expect(reversal(Kind.Refund, bet).checkReference(bet)).toEqual({ outcome: 'valid' });
  });

  test.each([Kind.Bet, Kind.Win])('ROLLBACK de %s processado é válido', (kind) => {
    const ref = processed({ kind });
    expect(reversal(Kind.Rollback, ref).checkReference(ref)).toEqual({ outcome: 'valid' });
  });

  test('ROLLBACK de REFUND processado é válido', () => {
    const refund = processed({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    expect(reversal(Kind.Rollback, refund).checkReference(refund)).toEqual({ outcome: 'valid' });
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['jogador', { playerId: 'player-2' }],
    ['rodada', { roundId: 'round-2' }],
  ])('referência de outro(a) %s é REFERENCE_SCOPE_MISMATCH', (_label, scope) => {
    const bet = processed();
    const refund = reversal(Kind.Refund, bet, scope);
    expect(refund.checkReference(bet)).toEqual({ outcome: 'invalid', code: FailureCode.ReferenceScopeMismatch });
  });

  test('referência em outra moeda é REFERENCE_SCOPE_MISMATCH', () => {
    const bet = processed();
    const refund = reversal(Kind.Refund, bet, { money: Money.from({ amount: '25.00', currency: 'USD' }) });
    expect(refund.checkReference(bet)).toEqual({ outcome: 'invalid', code: FailureCode.ReferenceScopeMismatch });
  });

  test.each([Kind.Win, Kind.Loss])('REFUND de %s é INVALID_REFERENCE_KIND', (kind) => {
    const ref = processed({ kind });
    expect(reversal(Kind.Refund, ref).checkReference(ref)).toEqual({
      outcome: 'invalid',
      code: FailureCode.InvalidReferenceKind,
    });
  });

  test('ROLLBACK de LOSS é INVALID_REFERENCE_KIND', () => {
    const loss = processed({ kind: Kind.Loss });
    expect(reversal(Kind.Rollback, loss).checkReference(loss)).toEqual({
      outcome: 'invalid',
      code: FailureCode.InvalidReferenceKind,
    });
  });

  test('ROLLBACK de ROLLBACK é INVALID_REFERENCE_KIND', () => {
    const rb = processed({ kind: Kind.Rollback, referenceExternalTransactionId: 'ext-y' });
    expect(reversal(Kind.Rollback, rb).checkReference(rb)).toEqual({
      outcome: 'invalid',
      code: FailureCode.InvalidReferenceKind,
    });
  });

  test('referência ainda não decidida: aguardar', () => {
    const pendingBet = tx();
    expect(reversal(Kind.Refund, pendingBet).checkReference(pendingBet)).toEqual({ outcome: 'wait' });
  });

  test('referência REJECTED é REFERENCE_NOT_PROCESSED', () => {
    const bet = tx();
    bet.reject(FailureCode.InsufficientFunds);
    expect(reversal(Kind.Refund, bet).checkReference(bet)).toEqual({
      outcome: 'invalid',
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test('valor diferente da referência é REVERSAL_AMOUNT_MISMATCH (sem reversão parcial)', () => {
    const bet = processed({ money: brl('25.00') });
    const partial = reversal(Kind.Refund, bet, { money: brl('10.00') });
    expect(partial.checkReference(bet)).toEqual({
      outcome: 'invalid',
      code: FailureCode.ReversalAmountMismatch,
    });
  });
});

// =========================================================================== persistência

describe('WagerTransaction.rehydrate', () => {
  test('toState e rehydrate fazem ida e volta', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-bet' });
    t.markPendingReference(T1);
    const copy = WagerTransaction.rehydrate(t.toState());
    expect(copy.toState()).toEqual(t.toState());
  });

  test('não revalida: reconstrói até um estado terminal', () => {
    const t = processed();
    const copy = WagerTransaction.rehydrate(t.toState());
    expect(copy.status).toBe(Status.Processed);
    expect(copy.isTerminal()).toBe(true);
  });
});
