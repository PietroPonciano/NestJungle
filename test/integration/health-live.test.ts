import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';
import { resetDatabase, testConfig } from '../support/database';

// Teste HTTP real: sobe a app numa porta efêmera e faz fetch de verdade,
// sem supertest nem mocks do pipeline do Nest.
describe('Health checks (abertos, sem autenticação)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    await (await resetDatabase()).close(true);
    ({ app } = await createApp(testConfig({ WORKERS_ENABLED: 'false' })));
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  test('GET /health/live responde 200 sem consultar dependências', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('GET /health/ready verifica PostgreSQL e SQS', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('GET /health/ready responde 503 quando o SQS está inalcançável', async () => {
    const { app: broken } = await createApp(
      testConfig({
        WORKERS_ENABLED: 'false',
        SQS_ENDPOINT: 'http://127.0.0.1:1',
        SQS_TRANSACTIONS_QUEUE_URL: 'http://127.0.0.1:1/000000000000/x.fifo',
      }),
    );
    await broken.listen(0);
    try {
      const res = await fetch(`${await broken.getUrl()}/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: 'unavailable',
        checks: { postgres: 'up', sqs: 'down' },
      });
    } finally {
      await broken.close();
    }
  });

  test('GET /metrics expõe métricas Prometheus', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wager_retries_total',
      'wager_dlq_messages_total',
      'wager_lock_conflicts_total',
      'outbox_lag_seconds',
      'outbox_pending_total',
      'wager_processing_duration_seconds',
      'reconciliation_divergence_total',
    ]) {
      expect(text).toContain(name);
    }
  });
});
