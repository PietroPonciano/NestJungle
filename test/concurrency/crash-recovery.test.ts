/**
 * Etapa 18 — crash e reinício com PROCESSOS REAIS (Bun.spawn + kill):
 *   5. worker morto depois do commit e antes do ack -> redelivery sem duplicar
 *   8. reinício do serviço (kill -9 no meio do processamento) -> consistência final
 *   +  SIGTERM: shutdown gracioso sem perder mensagens
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Client } from 'pg';
import { pgClient, resetDatabase } from '../support/database';
import {
  type Instance,
  type WalletRef,
  createWallet,
  http,
  messageBody,
  startInstance,
  waitFor,
  wagerBody,
} from '../support/instances';
import { assertLedgerInvariants } from '../support/invariants';
import { drain, queueDepth, testSqs } from '../support/sqs';

let c: Client;
let sqs: SQSClient;
let cfg: ReturnType<typeof testSqs>['config'];
const running: Instance[] = [];
// Visibility timeout curto: a redelivery após o crash acontece em segundos.
const FAST_REDELIVERY = { SQS_VISIBILITY_TIMEOUT_SECONDS: '3' };

beforeAll(async () => {
  await (await resetDatabase()).close(true);
  c = await pgClient();
  ({ client: sqs, config: cfg } = testSqs());
});
beforeEach(async () => {
  await drain(sqs, cfg.transactionsQueueUrl);
  await drain(sqs, cfg.transactionsDlqUrl);
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.kill('SIGKILL')));
  await assertLedgerInvariants(c);
});
afterAll(async () => {
  await c.end();
  sqs.destroy();
});

async function start(name: string, env: Record<string, string> = {}): Promise<Instance> {
  const i = await startInstance(name, { ...FAST_REDELIVERY, ...env });
  running.push(i);
  return i;
}

async function send(w: WalletRef, op: ReturnType<typeof wagerBody>): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: cfg.transactionsQueueUrl,
      MessageBody: JSON.stringify(messageBody(op)),
      MessageGroupId: w.id,
      MessageDeduplicationId: op.externalTransactionId,
    }),
  );
}

async function txCount(ext: string[]): Promise<number> {
  const r = await c.query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM wager_transactions WHERE external_transaction_id = ANY($1)',
    [ext],
  );
  return Number.parseInt(r.rows[0]?.n ?? '0', 10);
}

async function balance(walletId: string): Promise<string> {
  const r = await c.query<{ b: string }>('SELECT balance::text AS b FROM wallets WHERE id = $1', [
    walletId,
  ]);
  return r.rows[0]?.b ?? '';
}

describe('Crash e reinício (processos reais)', () => {
  test('5. worker morto DEPOIS do commit e ANTES do ack: redelivery não duplica o efeito', async () => {
    const crashing = await start('D-crash', { FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK: 'true' });
    const w = await createWallet(crashing, '100.00');
    const op = wagerBody(w, 'BET', '10.00');
    await send(w, op);

    // O processo comita e morre por SIGKILL antes de apagar a mensagem.
    await crashing.proc.exited;
    expect(crashing.proc.signalCode).toBe('SIGKILL');
    expect(await balance(w.id)).toBe('90.00'); // commit aconteceu
    expect(await queueDepth(sqs, cfg.transactionsQueueUrl)).toBe(1); // sem ack

    // Outra instância recebe a redelivery após o visibility timeout.
    const healthy = await start('E');
    await waitFor(
      async () => (await queueDepth(sqs, cfg.transactionsQueueUrl)) === 0,
      30_000,
      'redelivery confirmada',
    );
    expect(await txCount([op.externalTransactionId])).toBe(1);
    expect(await balance(w.id)).toBe('90.00');
    expect(healthy.logs.some((l) => l.includes('"duplicateMessage":true'))).toBe(true);
  });

  test('8. reinício: kill -9 no meio do processamento; nova instância conclui; consistência final comprovada', async () => {
    const first = await start('F');
    const wallets = await Promise.all([0, 1, 2].map(() => createWallet(first, '100.00')));
    const ops = wallets.flatMap((w) =>
      Array.from({ length: 10 }, () => ({ w, op: wagerBody(w, 'BET', '1.00') })),
    );
    for (const { w, op } of ops) await send(w, op);
    const ext = ops.map((o) => o.op.externalTransactionId);

    await waitFor(async () => (await txCount(ext)) >= 5, 30_000, '5 processadas');
    await first.kill('SIGKILL'); // morte abrupta: sem shutdown gracioso
    const processedBeforeCrash = await txCount(ext);
    expect(processedBeforeCrash).toBeLessThan(30);

    const second = await start('G');
    await waitFor(
      async () =>
        (await txCount(ext)) === 30 && (await queueDepth(sqs, cfg.transactionsQueueUrl)) === 0,
      60_000,
      'todas processadas',
    );
    for (const w of wallets) {
      expect(await balance(w.id)).toBe('90.00');
      const rec = await http(second, 'POST', `/wallets/${w.id}/reconciliation`);
      expect(rec.body.consistent).toBe(true);
    }
    // Outbox: tudo o que foi comitado (inclusive antes do crash) acaba publicado.
    await waitFor(
      async () => {
        const r = await c.query<{ n: string }>(
          'SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL',
        );
        return r.rows[0]?.n === '0';
      },
      30_000,
      'outbox drenada',
    );
    console.info(
      `[cenário 8] processadas antes do kill -9: ${String(processedBeforeCrash)}/30; restante concluído pela nova instância`,
    );
  });

  test('SIGTERM: shutdown gracioso conclui a mensagem em andamento; nada é perdido', async () => {
    const graceful = await start('H');
    const w = await createWallet(graceful, '100.00');
    const ops = Array.from({ length: 20 }, () => wagerBody(w, 'BET', '1.00'));
    for (const op of ops) await send(w, op);
    const ext = ops.map((o) => o.externalTransactionId);
    await waitFor(async () => (await txCount(ext)) >= 1, 30_000, 'primeira processada');

    const started = Date.now();
    await graceful.kill('SIGTERM');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(graceful.logs.some((l) => l.includes('workers parados'))).toBe(true);

    await start('I');
    await waitFor(
      async () =>
        (await txCount(ext)) === 20 && (await queueDepth(sqs, cfg.transactionsQueueUrl)) === 0,
      60_000,
      'todas processadas',
    );
    expect(await balance(w.id)).toBe('80.00');
  });
});
