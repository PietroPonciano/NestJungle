/**
 * Enunciado §3: "PostgreSQL e SQS podem ficar temporariamente indisponíveis".
 * A app fala com o PostgreSQL REAL através de um proxy TCP. Derrubar o proxy
 * simula a queda do banco sem afetar o resto da suíte. Esperado:
 *   - liveness 200 e readiness 503 durante a queda;
 *   - requisições recebem 503 + Retry-After (transitório, nada persistido — D7);
 *   - quando o banco volta, a app se recupera sozinha e o reenvio com a mesma
 *     Idempotency-Key aplica o efeito uma única vez.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { Socket, TCPSocketListener } from 'bun';
import type { Client } from 'pg';
import { createApp } from '../../src/bootstrap';
import { pgClient, resetDatabase, testConfig } from '../support/database';
import { waitFor } from '../support/instances';
import { assertLedgerInvariants } from '../support/invariants';

interface ClientData {
  upstream: Socket<UpstreamData> | undefined;
  pending: Uint8Array[];
}
interface UpstreamData {
  client: Socket<ClientData>;
}

/** Proxy TCP mínimo: 127.0.0.1:listenPort -> 127.0.0.1:targetPort. */
class TcpProxy {
  private server: TCPSocketListener<ClientData> | undefined;
  private readonly sockets = new Set<Socket<ClientData> | Socket<UpstreamData>>();

  constructor(
    readonly listenPort: number,
    private readonly targetPort: number,
  ) {}

  start(): void {
    if (this.server !== undefined) return; // já ligado
    const sockets = this.sockets;
    const targetPort = this.targetPort;
    this.server = Bun.listen<ClientData>({
      hostname: '127.0.0.1',
      port: this.listenPort,
      socket: {
        open(client) {
          sockets.add(client);
          client.data = { upstream: undefined, pending: [] };
          void Bun.connect<UpstreamData>({
            hostname: '127.0.0.1',
            port: targetPort,
            data: { client },
            socket: {
              open(up) {
                sockets.add(up);
                client.data.upstream = up;
                for (const chunk of client.data.pending) up.write(chunk);
                client.data.pending = [];
              },
              data(up, chunk) {
                up.data.client.write(chunk);
              },
              close(up) {
                up.data.client.end();
              },
              error() {
                client.end();
              },
            },
          }).catch(() => client.end());
        },
        data(client, chunk) {
          if (client.data.upstream !== undefined) client.data.upstream.write(chunk);
          else client.data.pending.push(new Uint8Array(chunk));
        },
        close(client) {
          client.data.upstream?.end();
        },
        error() {
          // conexão derrubada pela "queda"
        },
      },
    });
  }

  /** "Queda do banco": fecha o listener e todas as conexões abertas. */
  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
    for (const s of this.sockets) s.end();
    this.sockets.clear();
  }
}

let app: INestApplication;
let base: string;
let c: Client;
let proxy: TcpProxy;

beforeAll(async () => {
  await (await resetDatabase()).close(true);
  c = await pgClient();
  const realPort = testConfig().database.port;
  proxy = new TcpProxy(46_000 + Math.floor(Math.random() * 2_000), realPort);
  proxy.start();
  ({ app } = await createApp(
    testConfig({
      WORKERS_ENABLED: 'false',
      LOG_LEVEL: 'error',
      DATABASE_PORT: String(proxy.listenPort),
    }),
  ));
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  proxy.start(); // garante que o shutdown da app consiga fechar o pool
  await app.close();
  proxy.stop();
  await c.end();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe('PostgreSQL temporariamente indisponível', () => {
  test('queda: 503 + Retry-After e nada persistido; volta: recuperação automática e efeito aplicado 1×', async () => {
    const playerId = Bun.randomUUIDv7();
    const w = await call('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(w.status).toBe(201);
    const walletId = String(w.body.id);
    const bet = {
      providerId: 'provider-a',
      externalTransactionId: `outage-${Bun.randomUUIDv7()}`,
      playerId,
      walletId,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const key = { 'Idempotency-Key': `provider-a:${bet.externalTransactionId}` };

    proxy.stop(); // banco "cai"
    try {
      const live = await call('GET', '/health/live');
      expect(live.status).toBe(200);
      const ready = await call('GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({ checks: { postgres: 'down' } });

      const during = await call('POST', '/wagering/transactions', bet, key);
      expect(during.status).toBe(503);
      expect(during.headers.get('retry-after')).toBe('1');
      expect(during.body.error).toBe('TRANSIENT_INFRASTRUCTURE_ERROR');
      expect((await call('GET', `/wallets/${walletId}`)).status).toBe(503);
    } finally {
      proxy.start(); // banco "volta"
    }

    // Nada foi gravado durante a queda (verificado direto no banco, sem o proxy).
    const none = await c.query(
      'SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1',
      [bet.externalTransactionId],
    );
    expect(none.rowCount).toBe(0);

    await waitFor(
      async () => (await call('GET', '/health/ready')).status === 200,
      15_000,
      'readiness de volta',
    );
    const after = await call('POST', '/wagering/transactions', bet, key);
    expect(after.status).toBe(201);
    expect(after.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    const replay = await call('POST', '/wagering/transactions', bet, key);
    expect(replay.status).toBe(200);
    await assertLedgerInvariants(c);
  });
});
