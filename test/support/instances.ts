/**
 * Instâncias REAIS da aplicação como processos filhos (Bun.spawn), para os
 * cenários de múltiplas instâncias e de crash (enunciado §13). Cada uma tem
 * pool de conexões, consumidor SQS e workers próprios, como em produção.
 */
import type { Subprocess } from 'bun';
import { testEnv } from './database';

export interface Instance {
  name: string;
  port: number;
  url: string;
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  logs: string[];
  /** Envia o sinal e espera o processo sair; devolve o exit code. */
  kill(signal?: NodeJS.Signals): Promise<number | null>;
}

const ROOT = new URL('../../', import.meta.url).pathname;
let nextPort = 41_000 + Math.floor(Math.random() * 5_000);

async function pump(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    sink.push(...lines.filter((l) => l !== ''));
  }
}

/** Defaults rápidos para teste: long poll de 1 s, workers com polling curto. */
const FAST = {
  LOG_LEVEL: 'info',
  WORKERS_ENABLED: 'true',
  SQS_WAIT_TIME_SECONDS: '1',
  SQS_RETRY_BASE_SECONDS: '1',
  SQS_RETRY_MAX_SECONDS: '2',
  OUTBOX_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
  DATABASE_POOL_MAX: '10',
};

export async function startInstance(
  name: string,
  env: Record<string, string> = {},
): Promise<Instance> {
  const port = nextPort++;
  const logs: string[] = [];
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: testEnv({ ...FAST, PORT: String(port), ...env }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  void pump(proc.stdout, logs);
  void pump(proc.stderr, logs);
  const url = `http://127.0.0.1:${String(port)}`;
  const instance: Instance = {
    name,
    port,
    url,
    proc,
    logs,
    async kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      await proc.exited;
      return proc.exitCode;
    },
  };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null)
      throw new Error(`${name} saiu na inicialização:\n${logs.join('\n')}`);
    try {
      const res = await fetch(`${url}/health/ready`);
      if (res.status === 200) return instance;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  await instance.kill('SIGKILL');
  throw new Error(`${name} não ficou pronta:\n${logs.join('\n')}`);
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 30_000,
  label = 'condição',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`${label} não atingida em ${String(timeoutMs)} ms`);
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

export async function http(
  instance: Instance,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const res = await fetch(`${instance.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

export interface WalletRef {
  id: string;
  playerId: string;
}

export async function createWallet(instance: Instance, amount: string): Promise<WalletRef> {
  const playerId = Bun.randomUUIDv7();
  const r = await http(instance, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  if (r.status !== 201)
    throw new Error(`createWallet ${String(r.status)} ${JSON.stringify(r.body)}`);
  return { id: String(r.body.id), playerId };
}

export function wagerBody(
  w: WalletRef,
  kind: string,
  amount: string,
  over: Record<string, unknown> = {},
): { body: Record<string, unknown>; key: string; externalTransactionId: string } {
  const externalTransactionId =
    (over.externalTransactionId as string | undefined) ?? `tx-${Bun.randomUUIDv7()}`;
  return {
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...over,
    },
    key: `provider-a:${externalTransactionId}`,
    externalTransactionId,
  };
}

export function submitVia(
  instance: Instance,
  wager: ReturnType<typeof wagerBody>,
): Promise<HttpResult> {
  return http(instance, 'POST', '/wagering/transactions', wager.body, {
    'Idempotency-Key': wager.key,
  });
}

/** Corpo da mensagem SQS (enunciado §10) equivalente a um wagerBody. */
export function messageBody(
  wager: ReturnType<typeof wagerBody>,
  messageId = `msg-${Bun.randomUUIDv7()}`,
) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...wager.body, idempotencyKey: wager.key },
  };
}
