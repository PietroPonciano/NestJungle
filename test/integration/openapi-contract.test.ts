/**
 * Teste de contrato do OpenAPI: impede que o spec escrito à mão divirja do
 * código. App Nest real, PostgreSQL e LocalStack reais.
 *
 *  1. Rotas: o conjunto de rotas mapeadas pelo Nest == o conjunto documentado
 *     (fora /docs). Rota nova sem documentação (ou documentada sem existir) quebra.
 *  2. Respostas: cada cenário real devolve um status DOCUMENTADO para aquela
 *     operação e um corpo VÁLIDO contra o schema desse status (ajv, JSON Schema
 *     2020-12 = OpenAPI 3.1).
 *  3. Exemplos: todo exemplo do spec (requisição e resposta) valida contra o
 *     próprio schema.
 *  4. Export: docs/openapi.json está atualizado (`bun run openapi:export`).
 *  5. Swagger UI servido em /docs, com lista fechada de arquivos estáticos.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Client } from 'pg';
import { createApp } from '../../src/bootstrap';
import { OPENAPI_DOCUMENT } from '../../src/interfaces/http/openapi/openapi-document';
import { JsonLogger } from '../../src/shared/logger';
import { pgClient, resetDatabase, testConfig } from '../support/database';
import { assertLedgerInvariants } from '../support/invariants';

type Json = Record<string, unknown>;
interface Operation {
  responses: Record<
    string,
    {
      content?: Record<string, { schema?: unknown; examples?: Record<string, { value: unknown }> }>;
    }
  >;
  requestBody?: {
    content: Record<string, { schema: unknown; examples?: Record<string, { value: unknown }> }>;
  };
}

const spec = JSON.parse(JSON.stringify(OPENAPI_DOCUMENT)) as {
  paths: Record<string, Record<string, Operation>>;
};
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ ...spec, $id: 'https://wagering.local/openapi.json' });

const pointer = (...parts: string[]) =>
  parts.map((p) => p.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
function validatorFor(...parts: string[]) {
  return ajv.compile({ $ref: `https://wagering.local/openapi.json#/${pointer(...parts)}` });
}

const logs: Json[] = [];
let app: INestApplication;
let base: string;
let c: Client;
const covered = new Set<string>();

beforeAll(async () => {
  await (await resetDatabase()).close(true);
  c = await pgClient();
  const logger = new JsonLogger('debug', {}, (line) => {
    logs.push(JSON.parse(line) as Json);
  });
  ({ app } = await createApp(
    testConfig({ WORKERS_ENABLED: 'false', DATABASE_LOCK_TIMEOUT_MS: '300' }),
    { logger },
  ));
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  await c.end();
  await app.close();
});

/** Executa a requisição e valida status e corpo contra o contrato. */
async function call(
  method: 'get' | 'post',
  template: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method: method.toUpperCase(),
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const op = spec.paths[template]?.[method];
  if (op === undefined) throw new Error(`operação não documentada: ${method} ${template}`);
  const status = String(res.status);
  expect(
    Object.keys(op.responses),
    `${method.toUpperCase()} ${template} devolveu ${status} não documentado`,
  ).toContain(status);
  covered.add(`${method} ${template} ${status}`);

  const content = op.responses[status]?.content;
  if (content?.['application/json'] !== undefined) {
    const parsed = (await res.json()) as Json;
    const validate = validatorFor(
      'paths',
      template,
      method,
      'responses',
      status,
      'content',
      'application/json',
      'schema',
    );
    const valid = validate(parsed);
    expect(
      valid ? [] : validate.errors,
      `${method.toUpperCase()} ${template} ${status}: ${JSON.stringify(parsed)}`,
    ).toEqual([]);
    return { status: res.status, body: parsed, headers: res.headers };
  }
  await res.text();
  return { status: res.status, body: {}, headers: res.headers };
}

const W = '/wallets';
const W_ID = '/wallets/{walletId}';
const LEDGER = '/wallets/{walletId}/ledger';
const RECON = '/wallets/{walletId}/reconciliation';
const TX = '/wagering/transactions';
const TX_ID = '/wagering/transactions/{transactionId}';
const TX_EXT = '/providers/{providerId}/wagering/transactions/{externalTransactionId}';

async function newWallet(amount: string) {
  const playerId = Bun.randomUUIDv7();
  const r = await call('post', W, W, { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(r.status).toBe(201);
  return { id: String(r.body.id), playerId };
}

function wager(w: { id: string; playerId: string }, kind: string, amount: string, over: Json = {}) {
  const externalTransactionId = `ct-${Bun.randomUUIDv7()}`;
  return {
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'r',
      gameId: 'g',
      kind,
      money: { amount, currency: 'BRL' },
      ...over,
    },
    headers: { 'Idempotency-Key': `provider-a:${externalTransactionId}` },
    externalTransactionId,
  };
}
const submit = (w: ReturnType<typeof wager>) => call('post', TX, TX, w.body, w.headers);

describe('Contrato OpenAPI', () => {
  test('rotas expostas pelo Nest == rotas documentadas (fora /docs)', () => {
    const mapped = new Set(
      logs
        .map((l) => /Mapped \{(.+), (\w+)\} route/.exec(String(l.msg)))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => `${(m[2] ?? '').toLowerCase()} ${(m[1] ?? '').replace(/:(\w+)/g, '{$1}')}`)
        .filter((r) => !r.includes(' /docs')),
    );
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, ops]) =>
        Object.keys(ops).map((m) => `${m} ${path}`),
      ),
    );
    expect([...mapped].sort()).toEqual([...documented].sort());
  });

  test('todo exemplo do spec é válido contra o próprio schema', () => {
    let checked = 0;
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const req = op.requestBody?.content['application/json'];
        for (const [name, ex] of Object.entries(req?.examples ?? {})) {
          const v = validatorFor(
            'paths',
            path,
            method,
            'requestBody',
            'content',
            'application/json',
            'schema',
          );
          expect(
            v(ex.value) ? [] : v.errors,
            `${method} ${path} exemplo de requisição ${name}`,
          ).toEqual([]);
          checked += 1;
        }
        for (const [status, response] of Object.entries(op.responses)) {
          for (const [name, ex] of Object.entries(
            response.content?.['application/json']?.examples ?? {},
          )) {
            const v = validatorFor(
              'paths',
              path,
              method,
              'responses',
              status,
              'content',
              'application/json',
              'schema',
            );
            expect(
              v(ex.value) ? [] : v.errors,
              `${method} ${path} ${status} exemplo ${name}`,
            ).toEqual([]);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test('docs/openapi.json está atualizado (bun run openapi:export)', async () => {
    const exported: unknown = JSON.parse(
      await Bun.file(new URL('../../docs/openapi.json', import.meta.url)).text(),
    );
    expect(exported).toEqual(spec);
  });

  test('wallets: 201, 409, 400, 200, 404, ledger e reconciliação', async () => {
    const w = await newWallet('100.00');
    await call('post', W, W, {
      playerId: w.playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(
      (await call('post', W, W, { playerId: 'x', initialBalance: { amount: 1, currency: 'BRL' } }))
        .status,
    ).toBe(400);
    expect((await call('get', W_ID, `/wallets/${w.id}`)).status).toBe(200);
    expect((await call('get', W_ID, `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await call('get', W_ID, '/wallets/abc')).status).toBe(400);
    const page = await call('get', LEDGER, `/wallets/${w.id}/ledger?limit=1`);
    expect(page.status).toBe(200);
    expect((await call('get', LEDGER, `/wallets/${w.id}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await call('get', LEDGER, `/wallets/${Bun.randomUUIDv7()}/ledger`)).status).toBe(404);
    expect((await call('post', RECON, `/wallets/${w.id}/reconciliation`)).status).toBe(200);
    expect(
      (await call('post', RECON, `/wallets/${Bun.randomUUIDv7()}/reconciliation`)).status,
    ).toBe(404);
    expect((await call('post', RECON, '/wallets/abc/reconciliation')).status).toBe(400);
  });

  test('transações: 201, 200, 202, 422, 400, 404, 409, 500, 503 e consultas', async () => {
    const w = await newWallet('100.00');
    const bet = wager(w, 'BET', '25.00');
    const first = await submit(bet);
    expect(first.status).toBe(201);
    expect((await submit(bet)).status).toBe(200);
    expect(
      (await submit(wager(w, 'REFUND', '1.00', { referenceExternalTransactionId: 'ainda-nao' })))
        .status,
    ).toBe(202);
    expect((await submit(wager(w, 'BET', '9999.00'))).status).toBe(422);
    expect((await call('post', TX, TX, bet.body)).status).toBe(400); // sem Idempotency-Key
    expect(
      (await submit(wager(w, 'BET', '1.00', { money: { amount: 1, currency: 'BRL' } }))).status,
    ).toBe(400);
    expect(
      (await submit(wager({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() }, 'BET', '1.00')))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          'post',
          TX,
          TX,
          { ...bet.body, money: { amount: '26.00', currency: 'BRL' } },
          bet.headers,
        )
      ).status,
    ).toBe(409);

    // 500: falha permanente real no PostgreSQL (trigger de teste)
    await c.query(`
      CREATE OR REPLACE FUNCTION test_fail_ledger() RETURNS trigger AS $$
      BEGIN IF NEW.amount = 666.66 THEN RAISE EXCEPTION 'falha permanente simulada'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_ledger BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION test_fail_ledger();`);
    try {
      const rich = await newWallet('1000.00');
      expect((await submit(wager(rich, 'BET', '666.66'))).status).toBe(500);
    } finally {
      await c.query(
        'DROP TRIGGER test_fail_ledger ON wallet_ledger_entries; DROP FUNCTION test_fail_ledger();',
      );
    }

    // 503: lock da wallet seguro além do lock_timeout
    const holder = await pgClient();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [w.id]);
    try {
      const transient = await submit(wager(w, 'BET', '1.00'));
      expect(transient.status).toBe(503);
      expect(transient.headers.get('retry-after')).toBe('1');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }

    const txId = String(first.body.transactionId);
    expect((await call('get', TX_ID, `/wagering/transactions/${txId}`)).status).toBe(200);
    expect((await call('get', TX_ID, `/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(
      404,
    );
    expect((await call('get', TX_ID, '/wagering/transactions/abc')).status).toBe(400);
    expect(
      (
        await call(
          'get',
          TX_EXT,
          `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call('get', TX_EXT, '/providers/provider-a/wagering/transactions/nao-existe')).status,
    ).toBe(404);
    await assertLedgerInvariants(c);
  });

  test('operação: health e métricas', async () => {
    expect((await call('get', '/health/live', '/health/live')).status).toBe(200);
    expect((await call('get', '/health/ready', '/health/ready')).status).toBe(200);
    expect((await call('get', '/metrics', '/metrics')).status).toBe(200);
  });

  test('toda operação documentada foi exercitada contra a app real', () => {
    const operations = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m} ${path}`),
    );
    const exercised = new Set([...covered].map((k) => k.split(' ').slice(0, 2).join(' ')));
    expect(operations.filter((op) => !exercised.has(op))).toEqual([]);
    const pairs = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.entries(ops).flatMap(([m, op]) =>
        Object.keys(op.responses).map((s) => `${m} ${path} ${s}`),
      ),
    );
    console.info(
      `[contrato] ${String(covered.size)}/${String(pairs.length)} pares operação×status exercitados`,
    );
  });
});

describe('Swagger UI (/docs)', () => {
  test('página, spec e assets; arquivos fora da lista fechada dão 404', async () => {
    const page = await fetch(`${base}/docs`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('SwaggerUIBundle');
    const json = await fetch(`${base}/docs/openapi.json`);
    expect(await json.json()).toEqual(spec);
    const bundle = await fetch(`${base}/docs/assets/swagger-ui-bundle.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('content-type')).toContain('javascript');
    expect((await bundle.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
    for (const path of [
      '/docs/assets/package.json',
      '/docs/assets/..%2F..%2Fpackage.json',
      '/docs/assets/index.html',
    ]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
  });
});
