/**
 * Etapa 19 — uma requisição gera logs JSON correlacionados ponta a ponta
 * (HTTP -> transação -> outbox -> evento publicado), e as métricas aparecem no
 * endpoint. App completa com workers ligados; PostgreSQL e LocalStack reais.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';
import { JsonLogger } from '../../src/shared/logger';
import { resetDatabase, testConfig } from '../support/database';
import { waitFor } from '../support/instances';
import { drain, testSqs } from '../support/sqs';

const lines: Record<string, unknown>[] = [];
let app: INestApplication;
let base: string;

beforeAll(async () => {
  await (await resetDatabase()).close(true);
  const { client, config } = testSqs();
  await drain(client, config.eventsQueueUrl);
  client.destroy();
  const logger = new JsonLogger('info', {}, (line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  ({ app } = await createApp(
    testConfig({
      WORKERS_ENABLED: 'true',
      SQS_WAIT_TIME_SECONDS: '1',
      OUTBOX_POLL_INTERVAL_MS: '100',
    }),
    { logger },
  ));
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  await app.close();
});

async function post(path: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('Observabilidade', () => {
  test('logs JSON correlacionados: requisição -> transação -> evento publicado', async () => {
    const correlationId = `corr-${Bun.randomUUIDv7()}`;
    const playerId = Bun.randomUUIDv7();
    const w = await post(
      '/wallets',
      { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      {
        'x-correlation-id': correlationId,
      },
    );
    const walletId = String(w.body.id);
    const tx = await post(
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId: 'obs-1',
        playerId,
        walletId,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
      { 'Idempotency-Key': 'provider-a:obs-1', 'x-correlation-id': correlationId },
    );
    expect(tx.status).toBe(201);

    await waitFor(
      () =>
        Promise.resolve(
          lines.filter((l) => l.msg === 'evento publicado' && l.correlationId === correlationId)
            .length >= 4,
        ),
      15_000,
      'eventos publicados',
    );
    const correlated = lines.filter((l) => l.correlationId === correlationId);
    const msgs = new Set(correlated.map((l) => l.msg));
    expect(msgs).toEqual(
      new Set(['requisição HTTP', 'transação submetida via HTTP', 'evento publicado']),
    );

    const submitted = correlated.find((l) => l.msg === 'transação submetida via HTTP');
    expect(submitted).toMatchObject({
      level: 'info',
      transactionId: tx.body.transactionId,
      walletId,
      providerId: 'provider-a',
      status: 'PROCESSED',
    });
    const published = correlated
      .filter((l) => l.msg === 'evento publicado')
      .map((l) => l.eventType);
    expect(published.sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    const request = correlated.find(
      (l) => l.msg === 'requisição HTTP' && l.path === '/wagering/transactions',
    );
    expect(request).toMatchObject({ method: 'POST', status: 201 });
    expect(typeof request?.durationMs).toBe('number');

    // Sem payload financeiro nos logs: nenhum campo carrega valores monetários.
    for (const l of lines) {
      expect(JSON.stringify(l)).not.toContain('"amount"');
    }
  });

  test('métricas refletem o tráfego (transações por status, duplicatas, latência, outbox)', async () => {
    const playerId = Bun.randomUUIDv7();
    const w = await post(
      '/wallets',
      { playerId, initialBalance: { amount: '5.00', currency: 'BRL' } },
      {},
    );
    const body = {
      providerId: 'provider-a',
      externalTransactionId: 'obs-2',
      playerId,
      walletId: String(w.body.id),
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    await post('/wagering/transactions', body, { 'Idempotency-Key': 'provider-a:obs-2' }); // 422
    await post('/wagering/transactions', body, { 'Idempotency-Key': 'provider-a:obs-2' }); // replay

    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 1');
    expect(text).toContain('wager_transactions_total{kind="BET",status="REJECTED"} 1');
    expect(text).toMatch(/wager_duplicates_total \d+/);
    expect(text).not.toContain('wager_duplicates_total 0');
    expect(text).toMatch(/wager_processing_duration_seconds_count\{source="http"\} [1-9]/);
    expect(text).toMatch(/outbox_pending_total \d+/);
    expect(text).toMatch(/outbox_lag_seconds \d/);
  });
});
