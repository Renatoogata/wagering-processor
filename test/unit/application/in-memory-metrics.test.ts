import { describe, expect, test } from 'bun:test';
import { InMemoryMetrics } from '../../../src/application/ports/observability';

describe('InMemoryMetrics (formato Prometheus)', () => {
  test('contador com labels: a ordem dos labels não cria série nova', () => {
    const m = new InMemoryMetrics();
    m.increment('tx_total', { channel: 'http', status: 'PROCESSED' });
    m.increment('tx_total', { status: 'PROCESSED', channel: 'http' }, 2);
    expect(m.counter('tx_total', { channel: 'http', status: 'PROCESSED' })).toBe(3);
    expect(m.render()).toContain('# TYPE tx_total counter\ntx_total{channel="http",status="PROCESSED"} 3');
  });

  test('histograma: buckets CUMULATIVOS, +Inf = count, e soma', () => {
    const m = new InMemoryMetrics([0.1, 1]);
    for (const v of [0.05, 0.5, 0.7, 3]) m.observe('lat_seconds', v);
    const text = m.render();
    expect(text).toContain('lat_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('lat_seconds_bucket{le="1"} 3');
    expect(text).toContain('lat_seconds_bucket{le="+Inf"} 4');
    expect(text).toContain('lat_seconds_count 4');
    expect(m.histogram('lat_seconds')).toEqual({ count: 4, sum: 4.25 });
  });

  test('memória constante: um milhão de observações não guarda um milhão de números', () => {
    const m = new InMemoryMetrics([1]);
    for (let i = 0; i < 1_000_000; i++) m.observe('x', 0.5);
    expect(m.render().split('\n').filter(Boolean)).toHaveLength(5); // TYPE + 2 buckets + sum + count
  });

  test('medidores (gauges) e escape de aspas nos labels', () => {
    const m = new InMemoryMetrics();
    m.increment('errors_total', { reason: 'say "hi"' });
    const text = m.render({ outbox_pending_messages: 7 });
    expect(text).toContain('errors_total{reason="say \\"hi\\""} 1');
    expect(text).toContain('# TYPE outbox_pending_messages gauge\noutbox_pending_messages 7');
  });
});
