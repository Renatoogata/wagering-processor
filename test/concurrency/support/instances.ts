import type { Subprocess } from 'bun';

/**
 * Sobe instâncias REAIS da aplicação (processos `bun run src/main.ts` separados),
 * todas apontando para o MESMO Postgres e as MESMAS filas. É o "≥ 3 processos/instâncias"
 * da seção 13: nada é compartilhado em memória; só o banco e a SQS.
 */
export interface Instance {
  name: string;
  port: number;
  baseUrl: string;
  process: Subprocess;
  /** SIGTERM: desligamento gracioso (termina o que está em andamento). */
  terminate(): Promise<void>;
  /** SIGKILL: morte súbita, sem chance de terminar nada (crash, OOM, kill -9). */
  kill(): Promise<void>;
}

export interface InstanceQueues {
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
}

let nextPort = 3300 + Math.floor(Math.random() * 500);

export async function startInstance(name: string, queues: InstanceQueues): Promise<Instance> {
  const port = nextPort++;
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      SQS_WAGER_QUEUE_URL: queues.wagerQueueUrl,
      SQS_WAGER_DLQ_URL: queues.wagerDlqUrl,
      SQS_EVENTS_QUEUE_URL: queues.eventsQueueUrl,
      // outras suítes desligam os workers no process.env do runner: aqui eles PRECISAM rodar
      SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const baseUrl = `http://localhost:${port}`;
  await waitUntilReady(baseUrl, proc);
  return {
    name,
    port,
    baseUrl,
    process: proc,
    terminate: async () => {
      proc.kill('SIGTERM');
      await proc.exited;
    },
    kill: async () => {
      proc.kill('SIGKILL');
      await proc.exited;
    },
  };
}

async function waitUntilReady(baseUrl: string, proc: Subprocess, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`instance at ${baseUrl} exited with ${proc.exitCode}`);
    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`instance at ${baseUrl} not ready after ${timeoutMs}ms`);
}

/** Lê um contador do /metrics de uma instância (soma das séries que casam com o filtro). */
export async function scrapeCounter(baseUrl: string, name: string, labelFilter = ''): Promise<number> {
  const text = await (await fetch(`${baseUrl}/metrics`)).text();
  return text
    .split('\n')
    .filter((line) => line.startsWith(name) && line.includes(labelFilter) && !line.startsWith('#'))
    .reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
}
