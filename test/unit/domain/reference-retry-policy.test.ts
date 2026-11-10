import { describe, expect, test } from 'bun:test';
import { ReferenceRetryPolicy } from '../../../src/domain/wagering';

const NOW = new Date('2026-11-10T12:00:00Z');
const delayOf = (policy: ReferenceRetryPolicy, attempts: number) =>
  (policy.nextAttemptAt(attempts, NOW)?.getTime() ?? Number.NaN) - NOW.getTime();

describe('ReferenceRetryPolicy', () => {
  test('backoff exponencial: 1s, 2s, 4s, 8s', () => {
    const policy = new ReferenceRetryPolicy();
    expect([0, 1, 2, 3].map((a) => delayOf(policy, a))).toEqual([1000, 2000, 4000, 8000]);
  });

  test('a espera é limitada a maxDelayMs', () => {
    const policy = new ReferenceRetryPolicy({ maxDelayMs: 5000, maxAttempts: 50 });
    expect(delayOf(policy, 10)).toBe(5000);
  });

  test('esgotado o limite, devolve undefined', () => {
    const policy = new ReferenceRetryPolicy({ maxAttempts: 3 });
    expect(policy.nextAttemptAt(2, NOW)).toBeDefined();
    expect(policy.nextAttemptAt(3, NOW)).toBeUndefined();
  });

  test('a janela total default fica em torno de 25 minutos', () => {
    const policy = new ReferenceRetryPolicy();
    let total = 0;
    for (let a = 0; ; a++) {
      const next = policy.nextAttemptAt(a, NOW);
      if (!next) break;
      total += next.getTime() - NOW.getTime();
    }
    const minutes = total / 60_000;
    expect(minutes).toBeGreaterThan(20);
    expect(minutes).toBeLessThan(30);
  });
});
