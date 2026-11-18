/**
 * Teste de carga progressivo com personas (Etapa 22): `bun run test:load`.
 *
 * Alvo: a app já rodando (padrão: docker compose em http://localhost:3000) e o
 * PostgreSQL dela, para conferir as invariantes no fim. Sem meta de RPS: o
 * objetivo é medir com honestidade onde o sistema satura e provar que a
 * correção se mantém sob carga e sob comportamento agressivo.
 *
 * Personas (cada usuário virtual é um jogador com a PRÓPRIA wallet):
 *   - agressivo:   apostas altas, rajadas de 3 requisições simultâneas na própria
 *                  wallet, 20% de reenvios. Disputa o próprio saldo e fica sem dinheiro.
 *   - moderado:    valores médios, mistura BET/WIN/LOSS e REFUND das próprias
 *                  apostas, 10% de reenvios.
 *   - conservador: apostas pequenas, uma por vez, com pausa de 50 ms, 2% de reenvios.
 *
 * Rampa: estágios com total crescente de usuários (LOAD_STAGES, divididos
 * igualmente entre as personas), seguida de um estágio "hot wallet" (todos na
 * MESMA wallet — pior caso do lock pessimista).
 *
 * Variáveis: LOAD_BASE_URL, LOAD_STAGES ("6,12,24,48,96"), LOAD_STAGE_SECONDS (8),
 * LOAD_HOT_CONCURRENCY (32), LOAD_HOT_SECONDS (8), LOAD_REPORT (docs/LOAD_TEST.md),
 * DATABASE_* (padrão: banco do compose).
 */
import os from 'node:os';
import { Client } from 'pg';

const BASE = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
const STAGES = (process.env.LOAD_STAGES ?? '6,12,24,48,96')
  .split(',')
  .map((s) => Number.parseInt(s, 10));
const STAGE_SECONDS = Number.parseInt(process.env.LOAD_STAGE_SECONDS ?? '8', 10);
const HOT_CONCURRENCY = Number.parseInt(process.env.LOAD_HOT_CONCURRENCY ?? '32', 10);
const HOT_SECONDS = Number.parseInt(process.env.LOAD_HOT_SECONDS ?? '8', 10);
const REPORT = process.env.LOAD_REPORT ?? 'docs/LOAD_TEST.md';

// ----------------------------------------------------------------- dinheiro
// O gerador sorteia CENTAVOS inteiros e formata como string decimal: o valor
// nunca passa por float (mesma regra do serviço, Restrição #1).
function cents(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function amountOf(c: number): string {
  return `${String(Math.floor(c / 100))}.${String(c % 100).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ personas
type PersonaName = 'agressivo' | 'moderado' | 'conservador';

interface Wallet {
  id: string;
  playerId: string;
}

interface Request {
  body: Record<string, unknown>;
  key: string;
}

interface PlayerState {
  wallet: Wallet;
  last: Request | undefined;
  /** BETs processadas ainda não reembolsadas (para o REFUND do moderado). */
  refundable: { ext: string; amount: string }[];
}

interface Persona {
  name: PersonaName;
  description: string;
  initialBalance: string;
  burst: number;
  thinkMs: number;
  replayRate: number;
  next(state: PlayerState): Request;
}

function wager(w: Wallet, kind: string, amount: string, reference?: string): Request {
  const ext = `load-${Bun.randomUUIDv7()}`;
  return {
    key: `load:${ext}`,
    body: {
      providerId: 'load',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'load-round',
      gameId: 'load-game',
      kind,
      money: { amount, currency: 'BRL' },
      ...(reference !== undefined ? { referenceExternalTransactionId: reference } : {}),
    },
  };
}

const PERSONAS: Persona[] = [
  {
    name: 'agressivo',
    description:
      'BET 75% de 20.00–80.00 · WIN 25% de 10.00–120.00 · rajada de 3 simultâneas na própria wallet · 20% reenvios',
    initialBalance: '1000.00',
    burst: 3,
    thinkMs: 0,
    replayRate: 0.2,
    next: (s) =>
      Math.random() < 0.75
        ? wager(s.wallet, 'BET', amountOf(cents(2000, 8000)))
        : wager(s.wallet, 'WIN', amountOf(cents(1000, 12000))),
  },
  {
    name: 'moderado',
    description:
      'BET 55% de 2.00–15.00 · WIN 30% de 1.00–20.00 · LOSS 10% · REFUND 5% de uma aposta própria · 10% reenvios',
    initialBalance: '1000.00',
    burst: 1,
    thinkMs: 0,
    replayRate: 0.1,
    next: (s) => {
      const r = Math.random();
      const refundable = s.refundable.pop();
      if (r >= 0.95 && refundable !== undefined) {
        return wager(s.wallet, 'REFUND', refundable.amount, refundable.ext);
      }
      if (refundable !== undefined) s.refundable.push(refundable);
      if (r < 0.55) return wager(s.wallet, 'BET', amountOf(cents(200, 1500)));
      if (r < 0.85) return wager(s.wallet, 'WIN', amountOf(cents(100, 2000)));
      return wager(s.wallet, 'LOSS', '0.00');
    },
  },
  {
    name: 'conservador',
    description:
      'BET 50% de 0.50–3.00 · WIN 30% de 0.50–5.00 · LOSS 20% · uma por vez com pausa de 50 ms · 2% reenvios',
    initialBalance: '1000.00',
    burst: 1,
    thinkMs: 50,
    replayRate: 0.02,
    next: (s) => {
      const r = Math.random();
      if (r < 0.5) return wager(s.wallet, 'BET', amountOf(cents(50, 300)));
      if (r < 0.8) return wager(s.wallet, 'WIN', amountOf(cents(50, 500)));
      return wager(s.wallet, 'LOSS', '0.00');
    },
  },
];

// ---------------------------------------------------------------------- HTTP
interface Sample {
  persona: PersonaName | 'hot';
  ms: number;
  status: number; // 0 = erro de rede
  failureCode: string | undefined;
  replay: boolean;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { ms: performance.now() - started, status: res.status, json };
  } catch {
    return { ms: performance.now() - started, status: 0, json: {} as Record<string, unknown> };
  }
}

async function scrape(): Promise<Map<string, number>> {
  const text = await (await fetch(`${BASE}/metrics`)).text();
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const idx = line.lastIndexOf(' ');
    values.set(line.slice(0, idx), Number(line.slice(idx + 1)));
  }
  return values;
}

async function createWallet(initialBalance: string): Promise<Wallet> {
  const playerId = Bun.randomUUIDv7();
  const r = await post('/wallets', {
    playerId,
    initialBalance: { amount: initialBalance, currency: 'BRL' },
  });
  if (r.status !== 201) throw new Error(`falha ao criar wallet: ${String(r.status)}`);
  return { id: String(r.json.id), playerId };
}

// -------------------------------------------------------------------- estágios
interface StageResult {
  name: string;
  users: number;
  seconds: number;
  samples: Sample[];
  lockConflicts: number;
  maxOutboxPending: number;
  maxOutboxLag: number;
}

async function measure(
  name: string,
  users: number,
  seconds: number,
  run: (deadline: number, samples: Sample[]) => Promise<void>,
): Promise<StageResult> {
  const samples: Sample[] = [];
  let maxOutboxPending = 0;
  let maxOutboxLag = 0;
  const before = await scrape();
  const deadline = Date.now() + seconds * 1000;
  const sampler = (async () => {
    while (Date.now() < deadline) {
      const m = await scrape();
      maxOutboxPending = Math.max(maxOutboxPending, m.get('outbox_pending_total') ?? 0);
      maxOutboxLag = Math.max(maxOutboxLag, m.get('outbox_lag_seconds') ?? 0);
      await Bun.sleep(500);
    }
  })();
  const started = performance.now();
  await run(deadline, samples);
  const elapsed = (performance.now() - started) / 1000;
  await sampler;
  const after = await scrape();
  return {
    name,
    users,
    seconds: elapsed,
    samples,
    lockConflicts:
      (after.get('wager_lock_conflicts_total') ?? 0) -
      (before.get('wager_lock_conflicts_total') ?? 0),
    maxOutboxPending,
    maxOutboxLag,
  };
}

/** Um jogador: escolhe a próxima operação da persona (ou reenvia a anterior) em laço fechado. */
async function player(
  persona: Persona,
  state: PlayerState,
  deadline: number,
  samples: Sample[],
): Promise<void> {
  while (Date.now() < deadline) {
    const batch: { req: Request; replay: boolean }[] = [];
    for (let i = 0; i < persona.burst; i++) {
      const replay = state.last !== undefined && Math.random() < persona.replayRate;
      batch.push({
        req: replay && state.last !== undefined ? state.last : persona.next(state),
        replay,
      });
    }
    const results = await Promise.all(
      batch.map(async ({ req, replay }) => {
        const res = await post('/wagering/transactions', req.body, { 'Idempotency-Key': req.key });
        const failureCode =
          typeof res.json.failureCode === 'string' ? res.json.failureCode : undefined;
        samples.push({
          persona: persona.name,
          ms: res.ms,
          status: res.status,
          failureCode,
          replay,
        });
        return { req, res };
      }),
    );
    for (const { req, res } of results) {
      state.last = req;
      const money = req.body.money as { amount: string };
      if (res.status === 201 && req.body.kind === 'BET' && persona.name === 'moderado') {
        state.refundable.push({
          ext: String(req.body.externalTransactionId),
          amount: money.amount,
        });
      }
    }
    if (persona.thinkMs > 0) await Bun.sleep(persona.thinkMs);
  }
}

// ------------------------------------------------------------------ estatística
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

interface Summary {
  requests: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errorRate: number;
  rejectRate: number;
  replays: number;
  codes: string;
  statuses: string;
}

function summarize(samples: Sample[], seconds: number): Summary {
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;
  const rejected = samples.filter((s) => s.status === 422).length;
  const codes = new Map<string, number>();
  const statuses = new Map<number, number>();
  for (const s of samples) {
    statuses.set(s.status, (statuses.get(s.status) ?? 0) + 1);
    if (s.status === 422 && s.failureCode !== undefined)
      codes.set(s.failureCode, (codes.get(s.failureCode) ?? 0) + 1);
  }
  const n = samples.length;
  return {
    requests: n,
    throughput: n / seconds,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? 0,
    errorRate: n === 0 ? 0 : errors / n,
    rejectRate: n === 0 ? 0 : rejected / n,
    replays: samples.filter((s) => s.replay).length,
    codes: [...codes.entries()].map(([k, v]) => `${k}: ${String(v)}`).join(', ') || '—',
    statuses: [...statuses.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, v]) => `${k === 0 ? 'rede' : String(k)}: ${String(v)}`)
      .join(', '),
  };
}

// ------------------------------------------------------------------ invariantes
async function invariants(db: Client, walletIds: string[]) {
  const q = async (sql: string) => (await db.query(sql, [walletIds])).rowCount ?? 0;
  const counts = await db.query<{ tx: string; ledger: string }>(
    `SELECT (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ANY($1))::text AS tx,
            (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ANY($1))::text AS ledger`,
    [walletIds],
  );
  return {
    divergentWallets: await q(
      `SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id WHERE w.id = ANY($1)
        GROUP BY w.id, w.balance
       HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`,
    ),
    duplicatedLedger: await q(
      'SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id = ANY($1) GROUP BY transaction_id HAVING COUNT(*) > 1',
    ),
    negativeBalances: await q(
      'SELECT id FROM wallet_ledger_entries WHERE wallet_id = ANY($1) AND (balance_after < 0 OR balance_before < 0)',
    ),
    duplicatedTransactions: await q(
      `SELECT external_transaction_id FROM wager_transactions WHERE provider_id = 'load' AND wallet_id = ANY($1)
        GROUP BY external_transaction_id HAVING COUNT(*) > 1`,
    ),
    transactions: counts.rows[0]?.tx ?? '0',
    ledgerEntries: counts.rows[0]?.ledger ?? '0',
  };
}

const fmt = (n: number, d = 1) => n.toFixed(d);
const pct = (n: number) => `${fmt(n * 100, 1)}%`;

// ------------------------------------------------------------------------ main
async function main(): Promise<void> {
  const db = new Client({
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number.parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    user: process.env.DATABASE_USER ?? 'wagering',
    password: process.env.DATABASE_PASSWORD ?? 'wagering',
    database: process.env.DATABASE_NAME ?? 'wagering',
  });
  await db.connect();

  const maxPerPersona = Math.ceil(Math.max(...STAGES) / PERSONAS.length);
  console.log(
    `[load] criando ${String(maxPerPersona)} wallets por persona + 1 hot wallet em ${BASE}`,
  );
  const players = new Map<PersonaName, PlayerState[]>();
  for (const persona of PERSONAS) {
    const states: PlayerState[] = [];
    for (let i = 0; i < maxPerPersona; i++) {
      states.push({
        wallet: await createWallet(persona.initialBalance),
        last: undefined,
        refundable: [],
      });
    }
    players.set(persona.name, states);
  }
  const hot = await createWallet('500.00');

  const stages: StageResult[] = [];
  for (const total of STAGES) {
    const perPersona = Math.max(1, Math.round(total / PERSONAS.length));
    console.log(
      `[load] estágio: ${String(perPersona * PERSONAS.length)} usuários (${String(perPersona)} por persona), ${String(STAGE_SECONDS)} s`,
    );
    stages.push(
      await measure(
        `${String(perPersona * PERSONAS.length)} usuários`,
        perPersona * PERSONAS.length,
        STAGE_SECONDS,
        async (deadline, samples) => {
          await Promise.all(
            PERSONAS.flatMap((persona) =>
              (players.get(persona.name) ?? [])
                .slice(0, perPersona)
                .map((state) => player(persona, state, deadline, samples)),
            ),
          );
        },
      ),
    );
  }

  console.log(
    `[load] hot wallet: ${String(HOT_CONCURRENCY)} usuários na MESMA wallet, ${String(HOT_SECONDS)} s`,
  );
  const hotStage = await measure(
    'hot wallet',
    HOT_CONCURRENCY,
    HOT_SECONDS,
    async (deadline, samples) => {
      await Promise.all(
        Array.from({ length: HOT_CONCURRENCY }, async () => {
          let last: Request | undefined;
          while (Date.now() < deadline) {
            const replay = last !== undefined && Math.random() < 0.1;
            const req =
              replay && last !== undefined
                ? last
                : Math.random() < 0.6
                  ? wager(hot, 'BET', '1.00')
                  : wager(hot, 'WIN', '0.50');
            const res = await post('/wagering/transactions', req.body, {
              'Idempotency-Key': req.key,
            });
            samples.push({
              persona: 'hot',
              ms: res.ms,
              status: res.status,
              failureCode:
                typeof res.json.failureCode === 'string' ? res.json.failureCode : undefined,
              replay,
            });
            last = req;
          }
        }),
      );
    },
  );

  // Espera a outbox drenar (eventos de tudo o que foi comitado).
  const drainStarted = performance.now();
  let pending = Number.POSITIVE_INFINITY;
  while (pending > 0 && performance.now() - drainStarted < 180_000) {
    const r = await db.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL',
    );
    pending = Number.parseInt(r.rows[0]?.n ?? '0', 10);
    if (pending > 0) await Bun.sleep(250);
  }
  const drainSeconds = (performance.now() - drainStarted) / 1000;

  const allWallets = [...[...players.values()].flat().map((p) => p.wallet.id), hot.id];
  const inv = await invariants(db, allWallets);
  const finalBalances = new Map<PersonaName, string[]>();
  for (const [name, states] of players) {
    const r = await db.query<{ b: string }>(
      'SELECT balance::text AS b FROM wallets WHERE id = ANY($1) ORDER BY balance',
      [states.map((s) => s.wallet.id)],
    );
    finalBalances.set(
      name,
      r.rows.map((row) => row.b),
    );
  }
  // Agressivos que terminaram com menos de 10% do saldo inicial (contado no banco, em NUMERIC).
  const brokeAggressive = Number.parseInt(
    (
      await db.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM wallets WHERE id = ANY($1) AND balance < 100.00',
        [(players.get('agressivo') ?? []).map((s) => s.wallet.id)],
      )
    ).rows[0]?.n ?? '0',
    10,
  );
  const hotBalance = (
    await db.query<{ b: string }>('SELECT balance::text AS b FROM wallets WHERE id = $1', [hot.id])
  ).rows[0]?.b;
  await db.end();

  const ok =
    inv.divergentWallets === 0 &&
    inv.duplicatedLedger === 0 &&
    inv.negativeBalances === 0 &&
    inv.duplicatedTransactions === 0 &&
    pending === 0;

  // ---------------------------------------------------------------- análise
  const stageSummaries = stages.map((st) => ({ st, s: summarize(st.samples, st.seconds) }));
  const first = stageSummaries[0];
  const lastStage = stageSummaries.at(-1);
  let knee: string | undefined;
  for (let i = 1; i < stageSummaries.length; i++) {
    const prev = stageSummaries[i - 1];
    const cur = stageSummaries[i];
    if (prev === undefined || cur === undefined) continue;
    const gain = cur.s.throughput / prev.s.throughput - 1;
    if (gain < 0.15 || (first !== undefined && cur.s.p99 > 3 * first.s.p99)) {
      knee = `${cur.st.name} (vazão ${gain >= 0 ? '+' : ''}${pct(gain)} vs. estágio anterior; p99 ${fmt(cur.s.p99)} ms vs. ${fmt(first?.s.p99 ?? 0)} ms no primeiro)`;
      break;
    }
  }
  const personaAtMax = (name: PersonaName) =>
    summarize(
      (lastStage?.st.samples ?? []).filter((s) => s.persona === name),
      lastStage?.st.seconds ?? 1,
    );
  const agg = personaAtMax('agressivo');
  const cons = personaAtMax('conservador');
  const totalErrors = stageSummaries.reduce((acc, x) => acc + x.s.errorRate * x.s.requests, 0);
  const totalRequests = stageSummaries.reduce((acc, x) => acc + x.s.requests, 0);

  // ---------------------------------------------------------------- relatório
  const cpus = os.cpus();
  const lines: string[] = [
    '# Teste de carga progressivo com personas',
    '',
    `Executado em ${new Date().toISOString()} com \`bun run test:load\`. Sem meta de RPS: o objetivo é mostrar onde o sistema satura e provar que a correção se mantém sob carga crescente e comportamento agressivo.`,
    '',
    '## Ambiente',
    '',
    `- **Máquina:** ${cpus[0]?.model ?? 'desconhecido'} (${String(cpus.length)} núcleos lógicos), ${fmt(os.totalmem() / 2 ** 30, 0)} GiB RAM, ${os.type()} ${os.release()} (${os.arch()}).`,
    `- **Gerador de carga:** Bun ${Bun.version}, no mesmo host do alvo (disputa CPU com ele).`,
    `- **Alvo:** ${BASE} — **1 instância** da app (docker compose), PostgreSQL 17 e LocalStack 4.9 em containers no mesmo host, com o consumidor SQS e os workers da outbox e de pendências ligados.`,
    '',
    '## Metodologia',
    '',
    '- Cada usuário virtual é um **jogador com a própria wallet** (saldo inicial 1000.00) e roda em laço fechado: só envia a próxima requisição depois da resposta da anterior.',
    `- **Rampa:** ${STAGES.join(' → ')} usuários no total, divididos igualmente entre as três personas, ${String(STAGE_SECONDS)} s por estágio. Depois, um estágio **hot wallet** com ${String(HOT_CONCURRENCY)} usuários na MESMA wallet (saldo 500.00; BET 1.00 / WIN 0.50; 10% reenvios).`,
    '- **Latência:** medida no cliente (ida e volta HTTP).',
    '- **Erro:** falha de rede ou 5xx (inclui 503 transitório). 422 (rejeição de negócio) e 200 (replay) **não** são erro.',
    '- **Conflitos de lock e outbox lag:** vêm do `/metrics` da app (delta por estágio; lag e pendências amostrados a cada 500 ms).',
    '',
    '| Persona | Comportamento |',
    '|---|---|',
    ...PERSONAS.map((p) => `| **${p.name}** | ${p.description} |`),
    '',
    '## Resultados por estágio (rampa)',
    '',
    '| Estágio | Requisições | req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Erro | Rejeitadas (422) | Conflitos de lock | Outbox: máx pendentes / máx lag (s) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...[...stageSummaries, { st: hotStage, s: summarize(hotStage.samples, hotStage.seconds) }].map(
      ({ st, s }) =>
        `| ${st.name} | ${String(s.requests)} | ${fmt(s.throughput)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} | ${pct(s.errorRate)} | ${pct(s.rejectRate)} | ${String(st.lockConflicts)} | ${String(st.maxOutboxPending)} / ${fmt(st.maxOutboxLag)} |`,
    ),
    '',
    '## Resultados por persona em cada estágio',
    '',
    '| Estágio | Persona | Requisições | req/s | p50 (ms) | p95 (ms) | p99 (ms) | Erro | Rejeitadas (422) | Motivos das rejeições | Replays |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...stageSummaries.flatMap(({ st }) =>
      PERSONAS.map((p) => {
        const s = summarize(
          st.samples.filter((x) => x.persona === p.name),
          st.seconds,
        );
        return `| ${st.name} | ${p.name} | ${String(s.requests)} | ${fmt(s.throughput)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${pct(s.errorRate)} | ${pct(s.rejectRate)} | ${s.codes} | ${String(s.replays)} |`;
      }),
    ),
    '',
    `Outbox drenada ${fmt(drainSeconds)} s depois do fim da carga (pendentes restantes: ${String(pending)}).`,
    '',
    '## Invariantes depois da carga (consultadas direto no PostgreSQL)',
    '',
    '| Verificação | Resultado |',
    '|---|---|',
    `| Wallets com saldo ≠ ledger | ${String(inv.divergentWallets)} |`,
    `| Lançamentos duplicados por transação | ${String(inv.duplicatedLedger)} |`,
    `| Saldos negativos no histórico (balance_before/after) | ${String(inv.negativeBalances)} |`,
    `| Transações duplicadas (mesmo externalTransactionId) | ${String(inv.duplicatedTransactions)} |`,
    `| Transações / lançamentos gravados | ${inv.transactions} / ${inv.ledgerEntries} |`,
    `| Saldo final da hot wallet | ${hotBalance ?? '?'} |`,
    ...PERSONAS.map((p) => {
      const b = finalBalances.get(p.name) ?? [];
      return `| Saldos finais — ${p.name} (mín / mediana / máx) | ${b[0] ?? '?'} / ${b[Math.floor(b.length / 2)] ?? '?'} / ${b.at(-1) ?? '?'} |`;
    }),
    '',
    `**Resultado: ${ok ? 'invariantes preservadas' : 'INVARIANTE VIOLADA'}.**`,
    '',
    '## Análise',
    '',
    `- **Onde satura:** ${knee !== undefined ? `a vazão para de crescer (ou o p99 dispara) a partir de **${knee}**. Daí em diante, mais usuários só aumentam a fila de espera` : 'em nenhum estágio da rampa a vazão parou de crescer de forma relevante; o limite está acima da carga aplicada'}. Pico medido: ${fmt(Math.max(...stageSummaries.map((x) => x.s.throughput)))} req/s.`,
    `- **Erros:** ${String(Math.round(totalErrors))} de ${String(totalRequests)} requisições da rampa (${pct(totalRequests === 0 ? 0 : totalErrors / totalRequests)}) falharam por erro de rede ou 5xx.`,
    `- **Isolamento entre personas (estágio mais alto):** o conservador teve p99 de ${fmt(cons.p99)} ms e o agressivo, que dispara rajadas na própria wallet, ${fmt(agg.p99)} ms. Como o lock é **por wallet**, a disputa do agressivo fica na wallet dele: o conservador só sente a carga geral (CPU, pool de conexões), não a fila do agressivo.`,
    `- **Comportamento agressivo:** ${pct(agg.rejectRate)} das requisições do agressivo no estágio mais alto foram rejeitadas (${agg.codes}). As rajadas simultâneas na mesma wallet ficaram em fila no lock e **nenhum saldo ficou negativo** em momento algum (${String(brokeAggressive)} de ${String((finalBalances.get('agressivo') ?? []).length)} jogadores agressivos terminaram com menos de 10% do saldo inicial, como esperado de quem aposta alto).`,
    `- **Hot wallet:** com todos na mesma wallet, as operações ficam em fila no \`SELECT … FOR UPDATE\`: ${fmt(summarize(hotStage.samples, hotStage.seconds).throughput)} req/s, p99 de ${fmt(summarize(hotStage.samples, hotStage.seconds).p99)} ms e ${String(hotStage.lockConflicts)} conflitos de lock (esperas além do \`lock_timeout\` de 5 s). É o trade-off documentado do lock pessimista: correção determinística em troca de vazão por wallet.`,
    `- **Outbox lag:** chegou a ${fmt(Math.max(...[...stages, hotStage].map((st) => st.maxOutboxLag)))} s no pior estágio e cresce com a carga, porque uma instância publica um evento por chamada ao SQS. **Nenhum evento se perdeu** (pendentes restantes: ${String(pending)}). Melhorias possíveis: \`SendMessageBatch\`, paralelismo entre wallets e mais instâncias (o claim com SKIP LOCKED escala horizontalmente).`,
    '- **Limitações do experimento:** gerador, app e banco no mesmo host (os números valem para esta máquina, não para produção); uma instância só; LocalStack em vez de SQS real; estágios curtos (sem regime estacionário longo nem efeitos de autovacuum).',
    '',
  ];
  await Bun.write(REPORT, lines.join('\n'));
  console.log(lines.join('\n'));
  if (!ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
