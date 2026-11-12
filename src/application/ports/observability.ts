/**
 * Observabilidade como porta: o caso de uso diz O QUE aconteceu ("divergência na
 * reconciliação"), e a infraestrutura decide COMO registrar (console JSON, Prometheus...).
 * Assim os testes conseguem verificar que a métrica foi incrementada.
 */
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface AppLogger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface Metrics {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
}

export const APP_LOGGER = Symbol('APP_LOGGER');
export const METRICS = Symbol('METRICS');

/** Uma linha JSON por evento, sem payload financeiro completo (seção 12). */
export const jsonLogger: AppLogger = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};

function write(level: string, msg: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Para quem não precisa medir (testes, defaults). */
export const noopMetrics: Metrics = { increment: () => {}, observe: () => {} };

/**
 * Valores que não são contados no processo, mas LIDOS na hora da coleta
 * (ex.: quantos eventos estão pendentes na outbox). São iguais em todas as
 * instâncias, porque vêm do banco/fila, e não de memória.
 */
export interface OperationalGauges {
  collect(): Promise<Record<string, number>>;
}

export const OPERATIONAL_GAUGES = Symbol('OPERATIONAL_GAUGES');

/** Buckets (segundos) dos histogramas: de 5 ms (operação rápida) a 60 s (outbox parada). */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

interface Series {
  labels: Record<string, string>;
}
interface CounterSeries extends Series {
  value: number;
}
interface HistogramSeries extends Series {
  buckets: number[]; // contagem por bucket (não cumulativa)
  sum: number;
  count: number;
}

/**
 * Registro de métricas em memória, exposto em GET /metrics no formato texto do Prometheus.
 *
 * Histograma com buckets FIXOS (e não a lista de todas as observações): memória
 * constante, não importa quantas transações passem. É o que permite calcular p50/p95/p99
 * no Prometheus (histogram_quantile) somando as instâncias.
 *
 * Cada instância tem os SEUS contadores; quem soma é o Prometheus (sum by ...).
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, Map<string, CounterSeries>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();

  constructor(private readonly buckets: number[] = DEFAULT_BUCKETS) {}

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const series = getOrCreate(this.counters, name, labels, () => ({ labels, value: 0 }));
    series.value += value;
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const series = getOrCreate(this.histograms, name, labels, () => ({
      labels,
      buckets: this.buckets.map(() => 0),
      sum: 0,
      count: 0,
    }));
    const index = this.buckets.findIndex((upper) => value <= upper);
    if (index >= 0) series.buckets[index]! += 1;
    series.sum += value;
    series.count += 1;
  }

  counter(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(name)?.get(labelKey(labels))?.value ?? 0;
  }

  histogram(name: string, labels: Record<string, string> = {}): { count: number; sum: number } {
    const series = this.histograms.get(name)?.get(labelKey(labels));
    return { count: series?.count ?? 0, sum: series?.sum ?? 0 };
  }

  /** Formato de exposição do Prometheus (text/plain; version=0.0.4). */
  render(gauges: Record<string, number> = {}): string {
    const lines: string[] = [];
    for (const [name, seriesByKey] of [...this.counters].sort(byName)) {
      lines.push(`# TYPE ${name} counter`);
      for (const s of seriesByKey.values()) lines.push(`${name}${formatLabels(s.labels)} ${s.value}`);
    }
    for (const [name, seriesByKey] of [...this.histograms].sort(byName)) {
      lines.push(`# TYPE ${name} histogram`);
      for (const s of seriesByKey.values()) {
        let cumulative = 0;
        this.buckets.forEach((upper, i) => {
          cumulative += s.buckets[i]!;
          lines.push(`${name}_bucket${formatLabels({ ...s.labels, le: String(upper) })} ${cumulative}`);
        });
        lines.push(`${name}_bucket${formatLabels({ ...s.labels, le: '+Inf' })} ${s.count}`);
        lines.push(`${name}_sum${formatLabels(s.labels)} ${s.sum}`);
        lines.push(`${name}_count${formatLabels(s.labels)} ${s.count}`);
      }
    }
    for (const [name, value] of Object.entries(gauges).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    }
    return lines.join('\n') + '\n';
  }
}

function getOrCreate<T>(store: Map<string, Map<string, T>>, name: string, labels: Record<string, string>, create: () => T): T {
  let byKey = store.get(name);
  if (!byKey) store.set(name, (byKey = new Map()));
  const key = labelKey(labels);
  let series = byKey.get(key);
  if (!series) byKey.set(key, (series = create()));
  return series;
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `{${keys.map((k) => `${k}="${escape(labels[k]!)}"`).join(',')}}`;
}

const byName = ([a]: [string, unknown], [b]: [string, unknown]) => a.localeCompare(b);
