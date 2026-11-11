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

/**
 * Contadores e histogramas em memória. O dia 3 expõe isso em GET /metrics
 * (formato Prometheus); por enquanto já serve para os testes.
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, number[]>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = seriesKey(name, labels);
    const list = this.observations.get(key) ?? [];
    list.push(value);
    this.observations.set(key, list);
  }

  counter(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(seriesKey(name, labels)) ?? 0;
  }
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}
