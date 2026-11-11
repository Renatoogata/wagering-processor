// WalletBalanceChanged
import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money';
import { LedgerDirection, Wallet } from '../../../src/domain/wallet';
import { InvalidEventSourceError, WalletBalanceChanged, type EventContext } from '../../../src/domain/events';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const T0 = new Date('2026-11-11T12:00:00Z');
const ctx: EventContext = { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: T0 };

function openWallet(id = 'wallet-1') {
  return Wallet.open({
    id,
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-open',
    openingEntryId: 'entry-open',
    at: T0,
  }).wallet;
}

describe('WalletBalanceChanged.from', () => {
  test('descreve o débito a partir do lançamento', () => {
    const wallet = openWallet();
    const entry = wallet.debit({ entryId: 'e-1', transactionId: 'tx-1', money: brl('25.00'), at: T0 });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe('wallet-1');
    expect(event.data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('crédito também', () => {
    const wallet = openWallet();
    const entry = wallet.credit({ entryId: 'e-1', transactionId: 'tx-1', money: brl('10.00'), at: T0 });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(event.data.direction).toBe(LedgerDirection.Credit);
    expect(event.data.balanceAfter).toEqual({ amount: '110.00', currency: 'BRL' });
  });

  test('o envelope fica serializável (sem instâncias de Money)', () => {
    const wallet = openWallet();
    const entry = wallet.debit({ entryId: 'e-1', transactionId: 'tx-1', money: brl('25.00'), at: T0 });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(json.eventType).toBe('WalletBalanceChanged');
  });

  test('recusa lançamento de outra wallet', () => {
    const a = openWallet('wallet-a');
    const b = openWallet('wallet-b');
    const entryOfB = b.debit({ entryId: 'e-1', transactionId: 'tx-1', money: brl('5.00'), at: T0 });
    expect(() => WalletBalanceChanged.from(a, entryOfB, ctx)).toThrow(InvalidEventSourceError);
  });

  test('recusa lançamento antigo (o saldo publicado não seria mais verdade)', () => {
    const wallet = openWallet();
    const old = wallet.debit({ entryId: 'e-1', transactionId: 'tx-1', money: brl('5.00'), at: T0 });
    wallet.debit({ entryId: 'e-2', transactionId: 'tx-2', money: brl('5.00'), at: T0 });
    expect(() => WalletBalanceChanged.from(wallet, old, ctx)).toThrow(InvalidEventSourceError);
  });
});
