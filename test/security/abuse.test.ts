/**
 * Suíte de abuso e segurança: cada teste é uma TENTATIVA DE BURLAR o sistema
 * (como faria um provedor mal-intencionado ou um cliente com bug) e verifica a
 * defesa que a barra. App Nest real, PostgreSQL e LocalStack reais.
 *
 * Ao final de cada teste a invariante global é conferida direto no banco:
 * saldo == ledger, sem lançamento duplicado e sem saldo negativo.
 *
 * Mapa ataque → defesa → teste: docs/SEGURANCA.md.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { InvalidPayloadError, ProviderNotAuthorizedError } from '../../src/application/errors';
import type { ProviderIdentityPort } from '../../src/application/ports/provider-identity';
import { SubmitWagerTransactionUseCase } from '../../src/application/use-cases/submit-wager-transaction';
import { createApp } from '../../src/bootstrap';
import { createOrm } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';
import { parseWagerMessage } from '../../src/interfaces/messaging/wager-message';
import { pgClient, resetDatabase, testConfig } from '../support/database';
import { assertLedgerInvariants } from '../support/invariants';
import { K, brl, wagerCommand } from '../support/services';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  PendingReferencePolicy,
} from '../../src/domain/wager-transaction/pending-reference-policy';

type Json = Record<string, unknown>;
interface Res {
  status: number;
  body: Json;
  headers: Headers;
}

let app: INestApplication;
let base: string;
let c: Client;

beforeAll(async () => {
  await (await resetDatabase()).close(true);
  ({ app } = await createApp(
    testConfig({ WORKERS_ENABLED: 'false', LOG_LEVEL: 'error', DATABASE_LOCK_TIMEOUT_MS: '5000' }),
  ));
  await app.listen(0);
  base = await app.getUrl();
  c = await pgClient();
});
afterEach(async () => {
  await assertLedgerInvariants(c);
});
afterAll(async () => {
  await c.end();
  await app.close();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: parseBody(text), headers: res.headers };
}

function parseBody(text: string): Json {
  try {
    return text ? (JSON.parse(text) as Json) : {};
  } catch {
    return { raw: text };
  }
}

interface Wallet {
  id: string;
  playerId: string;
}

async function wallet(amount: string): Promise<Wallet> {
  const playerId = Bun.randomUUIDv7();
  const r = await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(r.status).toBe(201);
  return { id: String(r.body.id), playerId };
}

interface OpOverrides extends Json {
  externalTransactionId?: string;
  providerId?: string;
  key?: string;
}

function op(w: Wallet, kind: string, amount: unknown, over: OpOverrides = {}) {
  const externalTransactionId = over.externalTransactionId ?? `atk-${Bun.randomUUIDv7()}`;
  const providerId = over.providerId ?? 'provider-a';
  return {
    body: {
      providerId,
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
      ...over,
    },
    headers: { 'Idempotency-Key': over.key ?? `${providerId}:${externalTransactionId}` },
    externalTransactionId,
  };
}
const send = (o: ReturnType<typeof op>) =>
  call('POST', '/wagering/transactions', o.body, o.headers);

async function balance(walletId: string): Promise<string> {
  const r = await c.query<{ b: string }>('SELECT balance::text AS b FROM wallets WHERE id = $1', [
    walletId,
  ]);
  return r.rows[0]?.b ?? '';
}

async function txCount(walletId: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM wager_transactions WHERE wallet_id = $1 AND kind <> 'OPENING'",
    [walletId],
  );
  return Number.parseInt(r.rows[0]?.n ?? '0', 10);
}

// ---------------------------------------------------------------------------
describe('A. Dinheiro e saldo', () => {
  test('ATAQUE: rajada de 100 apostas paralelas de 1.00 numa wallet de 50.00 → DEFESA: lock por wallet; exatamente 50 aceitas e saldo 0.00', async () => {
    const w = await wallet('50.00');
    const results = await Promise.all(
      Array.from({ length: 100 }, () => send(op(w, 'BET', '1.00'))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(50);
    expect(
      results.filter((r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS'),
    ).toHaveLength(50);
    expect(await balance(w.id)).toBe('0.00');
  });

  test('ATAQUE: REFUND + ROLLBACK + segundo REFUND da mesma aposta, AO MESMO TEMPO → DEFESA: D1 sob o lock + índice único; só 1 reversão', async () => {
    const w = await wallet('100.00');
    for (let round = 0; round < 10; round++) {
      const bet = op(w, 'BET', '10.00');
      expect((await send(bet)).status).toBe(201);
      const ref = { referenceExternalTransactionId: bet.externalTransactionId };
      const attempts = await Promise.all([
        send(op(w, 'REFUND', '10.00', ref)),
        send(op(w, 'ROLLBACK', '10.00', ref)),
        send(op(w, 'REFUND', '10.00', ref)),
      ]);
      expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
      expect(
        attempts.filter((r) => r.status === 422 && r.body.failureCode === 'ALREADY_REVERSED'),
      ).toHaveLength(2);
    }
    expect(await balance(w.id)).toBe('100.00'); // cada BET foi devolvida uma única vez
  });

  test('ATAQUE: reverter um valor MAIOR que o apostado → DEFESA: AMOUNT_MISMATCH', async () => {
    const w = await wallet('100.00');
    const bet = op(w, 'BET', '10.00');
    await send(bet);
    const r = await send(
      op(w, 'REFUND', '100.00', { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe('AMOUNT_MISMATCH');
    expect(await balance(w.id)).toBe('90.00');
  });

  test('ATAQUE: desfazer a própria reversão (ROLLBACK de ROLLBACK) ou reembolsar um prêmio (REFUND de WIN) → DEFESA: REFERENCE_INVALID_KIND', async () => {
    const w = await wallet('100.00');
    const bet = op(w, 'BET', '10.00');
    await send(bet);
    const rb = op(w, 'ROLLBACK', '10.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await send(rb)).status).toBe(201);
    const rbOfRb = await send(
      op(w, 'ROLLBACK', '10.00', { referenceExternalTransactionId: rb.externalTransactionId }),
    );
    expect(rbOfRb.body.failureCode).toBe('REFERENCE_INVALID_KIND');
    const win = op(w, 'WIN', '20.00');
    await send(win);
    const refundOfWin = await send(
      op(w, 'REFUND', '20.00', { referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(refundOfWin.body.failureCode).toBe('REFERENCE_INVALID_KIND');
    expect(await balance(w.id)).toBe('120.00');
  });

  test('ATAQUE: ganhar, gastar o prêmio e pedir ROLLBACK do prêmio (saldo ficaria negativo) → DEFESA: REVERSAL_WOULD_OVERDRAW', async () => {
    const w = await wallet('0.00');
    const win = op(w, 'WIN', '50.00');
    await send(win);
    await send(op(w, 'BET', '45.00'));
    const r = await send(
      op(w, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    expect(await balance(w.id)).toBe('5.00');
  });

  test('ATAQUE: crédito que estouraria NUMERIC(18,2) → DEFESA: 422 BALANCE_LIMIT_EXCEEDED, saldo intacto (não vira 500)', async () => {
    const w = await wallet('9999999999999999.99');
    const r = await send(op(w, 'WIN', '1.00'));
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await balance(w.id)).toBe('9999999999999999.99');
  });

  test('ATAQUE: valores malformados para enganar o parser → DEFESA: 400 em todos, nada gravado', async () => {
    const w = await wallet('100.00');
    const bad: unknown[] = [
      '-1.00',
      '-0.01',
      '1e9',
      '1E2',
      '0.001',
      '10.999',
      'NaN',
      'Infinity',
      '-Infinity',
      '1,00',
      '',
      ' 1.00',
      '1.00 ',
      '00.10',
      '+1.00',
      '0x10',
      '10000000000000000.00',
      10,
      10.5,
      null,
      true,
      ['1.00'],
      { v: '1.00' },
    ];
    for (const amount of bad) {
      const r = await send(op(w, 'BET', amount));
      expect(r.status, `amount ${JSON.stringify(amount)}`).toBe(400);
    }
    for (const kind of ['BET', 'WIN']) {
      expect((await send(op(w, kind, '0.00'))).status, `${kind} 0.00`).toBe(400);
    }
    expect(await txCount(w.id)).toBe(0);
    expect(await balance(w.id)).toBe('100.00');
  });
});

// ---------------------------------------------------------------------------
describe('B. Identidade e referências', () => {
  test('ATAQUE: apostar na wallet de OUTRO jogador → DEFESA: PLAYER_MISMATCH; a vítima não é debitada', async () => {
    const victim = await wallet('100.00');
    const attacker = await wallet('100.00');
    const r = await send(op({ id: victim.id, playerId: attacker.playerId }, 'BET', '50.00'));
    expect(r.body.failureCode).toBe('PLAYER_MISMATCH');
    expect(await balance(victim.id)).toBe('100.00');
  });

  test('ATAQUE: usar a aposta de OUTRO jogador como referência de REFUND na própria wallet → DEFESA: REFERENCE_MISMATCH', async () => {
    const victim = await wallet('100.00');
    const attacker = await wallet('100.00');
    const victimBet = op(victim, 'BET', '40.00');
    await send(victimBet);
    const r = await send(
      op(attacker, 'REFUND', '40.00', {
        referenceExternalTransactionId: victimBet.externalTransactionId,
      }),
    );
    expect(r.body.failureCode).toBe('REFERENCE_MISMATCH');
    expect(await balance(attacker.id)).toBe('100.00');
    expect(await balance(victim.id)).toBe('60.00');
  });

  test('ATAQUE: provedor B tenta reverter a aposta do provedor A (mesmo externalTransactionId) → DEFESA: referência é resolvida por provedor; nunca credita', async () => {
    const w = await wallet('100.00');
    const betA = op(w, 'BET', '30.00', { providerId: 'provider-a' });
    await send(betA);
    const r = await send(
      op(w, 'REFUND', '30.00', {
        providerId: 'provider-b',
        referenceExternalTransactionId: betA.externalTransactionId,
      }),
    );
    // Para o provider-b a referência não existe: fica aguardando (e expira como REFERENCE_NOT_FOUND).
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('PENDING_REFERENCE');
    expect(await balance(w.id)).toBe('70.00');
  });

  test('ATAQUE: moeda trocada (USD numa wallet BRL) → DEFESA: CURRENCY_MISMATCH', async () => {
    const w = await wallet('100.00');
    const o = op(w, 'BET', '10.00');
    const r = await call(
      'POST',
      '/wagering/transactions',
      { ...o.body, money: { amount: '10.00', currency: 'USD' } },
      o.headers,
    );
    expect(r.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(await balance(w.id)).toBe('100.00');
  });

  test('ATAQUE: submeter OPENING (crédito interno de abertura) → DEFESA: 400, kind interno não é aceito', async () => {
    const w = await wallet('0.00');
    expect((await send(op(w, 'OPENING', '1000.00'))).status).toBe(400);
    expect((await send(op(w, 'opening', '1000.00'))).status).toBe(400);
    expect(await balance(w.id)).toBe('0.00');
  });

  test('ATAQUE: forjar status, id, saldo e failureCode no corpo (mass assignment) → DEFESA: campos fora do contrato são ignorados', async () => {
    const w = await wallet('100.00');
    const forged = '00000000-0000-0000-0000-000000000000';
    const o = op(w, 'BET', '10.00', {
      transactionId: forged,
      id: forged,
      status: 'PROCESSED',
      failureCode: null,
      balance: { amount: '999999.00', currency: 'BRL' },
      observedBalance: { amount: '999999.00', currency: 'BRL' },
      processedAt: '2000-01-01T00:00:00Z',
    });
    const r = await send(o);
    expect(r.status).toBe(201);
    expect(r.body.transactionId).not.toBe(forged);
    expect(r.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(await balance(w.id)).toBe('90.00');
  });

  test('ATAQUE: provedor sem permissão (quando a autenticação existir) → DEFESA: ProviderIdentityPort recusa antes de qualquer escrita', async () => {
    const orm: MikroORM = await createOrm(testConfig().database);
    try {
      const denyProviderB: ProviderIdentityPort = {
        authorize: (_principal, providerId) =>
          providerId === 'provider-b'
            ? Promise.reject(new ProviderNotAuthorizedError(providerId))
            : Promise.resolve(),
      };
      const submit = new SubmitWagerTransactionUseCase(
        new MikroOrmUnitOfWork(orm, 5000),
        new UuidV7Generator(),
        new SystemClock(),
        new PendingReferencePolicy(DEFAULT_PENDING_REFERENCE_POLICY),
        undefined,
        denyProviderB,
      );
      const w = await wallet('100.00');
      const cmd = wagerCommand(w, K.Win, '1000.00', { providerId: 'provider-b' });
      let caught: unknown;
      try {
        await submit.execute(cmd, { correlationId: 'atk', principal: 'client-provider-a' });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProviderNotAuthorizedError);
      expect(await txCount(w.id)).toBe(0);
      expect(await balance(w.id)).toBe('100.00');
      // O provedor autorizado segue normal.
      const ok = await submit.execute(wagerCommand(w, K.Bet, '1.00'), { correlationId: 'ok' });
      expect<string>(ok.result.status).toBe('PROCESSED');
    } finally {
      await orm.close(true);
    }
  });

  test('RISCO CONHECIDO: WIN sem referência credita direto (permitido pelo enunciado) → mitigação: autenticação + ProviderIdentityPort', async () => {
    // Documenta o comportamento: um provedor PODE creditar sem BET prévia. A
    // proteção é saber QUEM é o provedor (ponto de extensão acima), não a regra.
    const w = await wallet('0.00');
    const r = await send(op(w, 'WIN', '500.00'));
    expect(r.status).toBe(201);
    expect(await balance(w.id)).toBe('500.00');
  });
});

// ---------------------------------------------------------------------------
describe('C. Idempotência', () => {
  test('ATAQUE: reusar a Idempotency-Key de uma aposta trocando o valor → DEFESA: 409; o resultado original é preservado', async () => {
    const w = await wallet('100.00');
    const o = op(w, 'BET', '1.00');
    await send(o);
    const r = await call(
      'POST',
      '/wagering/transactions',
      { ...o.body, money: { amount: '99.00', currency: 'BRL' } },
      o.headers,
    );
    expect(r.status).toBe(409);
    const replay = await send(o);
    expect(replay.status).toBe(200);
    expect(replay.body.balance).toEqual({ amount: '99.00', currency: 'BRL' });
    expect(await balance(w.id)).toBe('99.00');
  });

  test('ATAQUE: mesmo externalTransactionId com outra chave (tentar aplicar 2×) → DEFESA: 409', async () => {
    const w = await wallet('100.00');
    const o = op(w, 'BET', '10.00');
    await send(o);
    const r = await call('POST', '/wagering/transactions', o.body, {
      'Idempotency-Key': `outra-${Bun.randomUUIDv7()}`,
    });
    expect(r.status).toBe(409);
    expect(await balance(w.id)).toBe('90.00');
  });

  test('ATAQUE: provedor B usa a mesma chave e o mesmo id do provedor A para "ler" o resultado dele → DEFESA: chave é por provedor (D5); é outra operação', async () => {
    const w = await wallet('100.00');
    const ext = `shared-${Bun.randomUUIDv7()}`;
    const a = await send(
      op(w, 'BET', '10.00', {
        providerId: 'provider-a',
        externalTransactionId: ext,
        key: 'chave-compartilhada',
      }),
    );
    const b = await send(
      op(w, 'BET', '10.00', {
        providerId: 'provider-b',
        externalTransactionId: ext,
        key: 'chave-compartilhada',
      }),
    );
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.transactionId).not.toBe(a.body.transactionId);
    expect(b.body.idempotentReplay).toBe(false);
    expect(await balance(w.id)).toBe('80.00');
  });
});

// ---------------------------------------------------------------------------
describe('D. Entrada e protocolo', () => {
  test('ATAQUE: SQL injection nos campos de texto → DEFESA: queries parametrizadas; gravado literalmente, tabelas intactas', async () => {
    const w = await wallet('100.00');
    const payloads = [
      "'; DROP TABLE wallets; --",
      "' OR '1'='1",
      'x"); DELETE FROM wallet_ledger_entries; --',
    ];
    for (const injection of payloads) {
      const r = await send(
        op(w, 'LOSS', '0.00', {
          roundId: injection,
          gameId: injection,
          externalTransactionId: `${injection}-${Bun.randomUUIDv7()}`,
        }),
      );
      expect(r.status).toBe(201);
    }
    const stored = await c.query<{ round_id: string }>(
      "SELECT round_id FROM wager_transactions WHERE wallet_id = $1 AND kind = 'LOSS' ORDER BY created_at",
      [w.id],
    );
    expect(stored.rows.map((r) => r.round_id)).toEqual(payloads);
    const byExt = await call(
      'GET',
      `/providers/provider-a/wagering/transactions/${encodeURIComponent("' OR '1'='1")}`,
    );
    expect(byExt.status).toBe(404); // não "acha tudo"
    const tables = await c.query(
      "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('wallets','wallet_ledger_entries')",
    );
    expect(tables.rowCount).toBe(2);
  });

  test('ATAQUE: ids maliciosos na rota → DEFESA: 400 (validação de UUID antes de chegar ao banco)', async () => {
    for (const path of [
      `/wallets/${encodeURIComponent("' OR 1=1 --")}`,
      '/wallets/..%2F..%2Fetc%2Fpasswd',
      '/wallets/00000000-0000-0000-0000-00000000000g',
      `/wagering/transactions/${encodeURIComponent('1; DROP TABLE x')}`,
    ]) {
      expect((await call('GET', path)).status, path).toBe(400);
    }
  });

  test('ATAQUE: corpo gigante (> 100 KB) → DEFESA: 413 PAYLOAD_TOO_LARGE', async () => {
    const r = await call(
      'POST',
      '/wagering/transactions',
      { pad: 'x'.repeat(200_000) },
      { 'Idempotency-Key': 'big' },
    );
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('PAYLOAD_TOO_LARGE');
  });

  test('ATAQUE: JSON malformado ou com tipo errado → DEFESA: 400', async () => {
    const h = { 'Idempotency-Key': 'malformado' };
    for (const raw of ['{"providerId":', '[]', '"texto"', 'null', '{"money":{"amount":"1.00"}}']) {
      expect((await call('POST', '/wagering/transactions', raw, h)).status, raw).toBe(400);
    }
  });

  test('ATAQUE: X-Correlation-Id malicioso (script, tamanho absurdo) para poluir logs → DEFESA: valor recusado e substituído por UUID', async () => {
    for (const evil of ['<script>alert(1)</script>', 'a'.repeat(5000), '{"msg":"forjado"}']) {
      const r = await call('GET', '/health/live', undefined, { 'X-Correlation-Id': evil });
      const echoed = r.headers.get('x-correlation-id') ?? '';
      expect(echoed).not.toBe(evil);
      expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test('ATAQUE: cursor e limit forjados para ler além da página ou de outra wallet → DEFESA: 400; cursor só filtra dentro da wallet', async () => {
    const mine = await wallet('10.00');
    const other = await wallet('10.00');
    const forged = (seq: string) => Buffer.from(JSON.stringify({ seq })).toString('base64url');
    expect(
      (await call('GET', `/wallets/${mine.id}/ledger?cursor=${forged('1 OR 1=1')}`)).status,
    ).toBe(400);
    expect((await call('GET', `/wallets/${mine.id}/ledger?cursor=${forged('-5')}`)).status).toBe(
      400,
    );
    for (const limit of ['1000000', '-1', '0', '1.5', 'abc']) {
      expect(
        (await call('GET', `/wallets/${mine.id}/ledger?limit=${limit}`)).status,
        `limit=${limit}`,
      ).toBe(400);
    }
    const page = await call('GET', `/wallets/${mine.id}/ledger?cursor=${forged('0')}`);
    const entries = page.body.entries as { transactionId: string }[];
    const otherTx = await c.query<{ id: string }>(
      'SELECT id FROM wager_transactions WHERE wallet_id = $1',
      [other.id],
    );
    for (const e of entries) expect(otherTx.rows.map((r) => r.id)).not.toContain(e.transactionId);
  });

  test('ATAQUE: path traversal nos arquivos do Swagger → DEFESA: lista fechada de arquivos (404)', async () => {
    for (const path of [
      '/docs/assets/..%2F..%2Fpackage.json',
      '/docs/assets/package.json',
      '/docs/assets/.env',
    ]) {
      expect((await call('GET', path)).status, path).toBe(404);
    }
  });

  test('ATAQUE: mensagem SQS com kind OPENING ou sem idempotencyKey → DEFESA: payload inválido (vai à DLQ, sem linha)', () => {
    const msg = (data: Json) =>
      JSON.stringify({
        messageId: 'm',
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data,
      });
    const base = {
      providerId: 'p',
      externalTransactionId: 'e',
      idempotencyKey: 'k',
      playerId: Bun.randomUUIDv7(),
      walletId: Bun.randomUUIDv7(),
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    };
    expect(() => parseWagerMessage(msg({ ...base, kind: 'OPENING' }))).toThrow(InvalidPayloadError);
    const noKey: Json = { ...base };
    delete noKey.idempotencyKey;
    expect(() => parseWagerMessage(msg(noKey))).toThrow(InvalidPayloadError);
    expect(() =>
      parseWagerMessage(msg({ ...base, money: { amount: 1, currency: 'BRL' } })),
    ).toThrow(InvalidPayloadError);
    expect(() => parseWagerMessage('{"type":"Outro"}')).toThrow(InvalidPayloadError);
  });
});

// Garante que os helpers de domínio usados acima continuam coerentes.
test('sanidade: brl() produz Money com 2 casas', () => {
  expect(brl('1').toString()).toBe('1.00');
});
