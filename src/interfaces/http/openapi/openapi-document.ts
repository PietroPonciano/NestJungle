/**
 * Contrato OpenAPI 3.1 da API HTTP, escrito à mão.
 *
 * Por que à mão e não gerado por decorators: a validação de entrada é manual
 * sobre `unknown` (o Bun não emite metadata de tipos — decisão E7), e o
 * comportamento que importa ao provedor (replay devolvendo o mesmo 422, 202 com
 * saldo atual, 503 transitório com Retry-After) não sai de anotação nenhuma.
 *
 * Fonte única com o código: os enums (failureCode, kinds, status) vêm do
 * domínio. O teste `openapi-contract.test.ts` sobe a app e garante que
 * (1) toda rota exposta está documentada e vice-versa, e (2) as respostas reais
 * de cada cenário obedecem ao schema documentado para aquele status.
 */
import { FAILURE_CODES, FailureCode } from '../../../domain/wager-transaction/failure-code';
import {
  SUBMITTABLE_KINDS,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction/wager-transaction-kind';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, examples?: Record<string, { summary: string; value: unknown }>) => ({
  'application/json': { schema, ...(examples !== undefined ? { examples } : {}) },
});

const UUID = { type: 'string', format: 'uuid' } as const;
const TEXT = { type: 'string', minLength: 1, maxLength: 255 } as const;

/** Respostas de erro reutilizadas por várias rotas (corpo `Error`). */
const errorResponse = (description: string, example: { error: string; message: string }) => ({
  description,
  headers: { 'X-Correlation-Id': { $ref: '#/components/headers/CorrelationId' } },
  content: json(ref('Error'), { exemplo: { summary: example.error, value: example } }),
});

const R400 = errorResponse(
  'Payload, header, parâmetro ou cursor inválido (`INVALID_PAYLOAD`). Reenvie só depois de corrigir.',
  { error: 'INVALID_PAYLOAD', message: 'Corpo inválido' },
);
const R404Wallet = errorResponse('Wallet inexistente (`WALLET_NOT_FOUND`). Nada é persistido.', {
  error: 'WALLET_NOT_FOUND',
  message: 'Wallet 0192f291-27dd-7d3f-8071-5f8685deef37 não encontrada',
});
const R404Tx = errorResponse('Transação inexistente (`TRANSACTION_NOT_FOUND`).', {
  error: 'TRANSACTION_NOT_FOUND',
  message: 'Transação não encontrada',
});
const R413 = errorResponse('Corpo acima do limite aceito (100 KB) — `PAYLOAD_TOO_LARGE`.', {
  error: 'PAYLOAD_TOO_LARGE',
  message: 'request entity too large',
});
const R403 = errorResponse(
  'O principal autenticado não pode agir como este provedor (`PROVIDER_NOT_AUTHORIZED`). Só ocorre quando a autenticação estiver habilitada (hoje o `ProviderIdentityPort` é permissivo).',
  {
    error: 'PROVIDER_NOT_AUTHORIZED',
    message: 'Não autorizado a submeter operações do provedor provider-a',
  },
);
const R503 = {
  description:
    'Falha transitória de infraestrutura (banco/SQS fora, lock da wallet além do `lock_timeout`, deadlock). Nada foi persistido (D7). **Reenvie com a mesma Idempotency-Key** depois de `Retry-After` segundos.',
  headers: {
    'Retry-After': {
      description: 'Segundos sugeridos antes de reenviar.',
      schema: { type: 'string', example: '1' },
    },
    'X-Correlation-Id': { $ref: '#/components/headers/CorrelationId' },
  },
  content: json(ref('Error'), {
    exemplo: {
      summary: 'TRANSIENT_INFRASTRUCTURE_ERROR',
      value: {
        error: 'TRANSIENT_INFRASTRUCTURE_ERROR',
        message: 'Falha transitória; reenvie com a mesma Idempotency-Key',
      },
    },
  }),
};
const ok = (
  description: string,
  schema: unknown,
  examples?: Record<string, { summary: string; value: unknown }>,
) => ({
  description,
  headers: { 'X-Correlation-Id': { $ref: '#/components/headers/CorrelationId' } },
  content: json(schema, examples),
});

const walletIdParam = {
  name: 'walletId',
  in: 'path',
  required: true,
  schema: UUID,
  description: 'Id interno da wallet.',
};
const correlationParam = { $ref: '#/components/parameters/CorrelationId' };

const EX_PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const EX_WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const EX_TX = '0192f298-345e-7e38-af88-e43f851a819d';
const wagerExample = (kind: string, amount: string, ext: string, reference?: string) => ({
  providerId: 'provider-a',
  externalTransactionId: ext,
  playerId: EX_PLAYER,
  walletId: EX_WALLET,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind,
  money: { amount, currency: 'BRL' },
  ...(reference !== undefined ? { referenceExternalTransactionId: reference } : {}),
});

const failureCodeDescription = Object.values(FailureCode)
  .map(
    (code) =>
      `- \`${code}\` (${FAILURE_CODES[code].category}, ${FAILURE_CODES[code].providerAction}): ${FAILURE_CODES[code].description}`,
  )
  .join('\n');

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'Distributed Wagering Processor',
    version: '1.0.0',
    description: [
      'Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) com entrega at-least-once, sem duplicar débito/crédito, sem perder eventos e sem saldo negativo.',
      '',
      '**Dinheiro** é sempre `MoneyProps`: `{ "amount": "25.00", "currency": "BRL" }` — string decimal com 2 casas, nunca número.',
      '',
      '**Idempotência:** `POST /wagering/transactions` exige o header `Idempotency-Key` (recomendado `{providerId}:{externalTransactionId}`). Requisição idêntica devolve o resultado original com `idempotentReplay: true`; mesma key com payload diferente é **409**.',
      '',
      '**Correlação:** envie `X-Correlation-Id` (ou ele é gerado); volta na resposta e segue para os logs e eventos.',
      '',
      '**Autenticação:** não implementada (decisão documentada no ARCHITECTURE.md §11; `AuthGuard` no-op como ponto de extensão).',
    ].join('\n'),
  },
  // O primeiro server vira o `baseUrl` quando o spec é importado no Postman/Insomnia;
  // o segundo (mesma origem) serve para quando a app roda em outro host/porta.
  servers: [
    { url: 'http://localhost:3000', description: 'Local (docker compose ou bun run dev)' },
    { url: '/', description: 'Mesma origem desta página' },
  ],
  tags: [
    { name: 'Wallets', description: 'Wallets, ledger e reconciliação' },
    { name: 'Wagering', description: 'Submissão e consulta de transações de aposta' },
    { name: 'Operação', description: 'Health checks e métricas (abertos)' },
  ],
  paths: {
    '/wallets': {
      post: {
        tags: ['Wallets'],
        operationId: 'createWallet',
        summary: 'Cria wallet',
        description:
          'Uma wallet por `playerId` + moeda. Saldo inicial > 0 gera a transação interna OPENING e o lançamento CREDIT na mesma transação SQL; saldo inicial zero não gera OPENING nem eventos (D3).',
        parameters: [correlationParam],
        requestBody: {
          required: true,
          content: json(ref('CreateWalletRequest'), {
            padrao: {
              summary: 'Saldo inicial 1000.00 BRL',
              value: {
                playerId: EX_PLAYER,
                initialBalance: { amount: '1000.00', currency: 'BRL' },
              },
            },
          }),
        },
        responses: {
          '201': ok('Wallet criada (version 1).', ref('Wallet'), {
            criada: {
              summary: 'Wallet criada',
              value: {
                id: EX_WALLET,
                playerId: EX_PLAYER,
                balance: { amount: '1000.00', currency: 'BRL' },
                version: 1,
              },
            },
          }),
          '400': R400,
          '409': errorResponse(
            'Já existe wallet para este player nesta moeda (`WALLET_ALREADY_EXISTS`).',
            {
              error: 'WALLET_ALREADY_EXISTS',
              message: 'Já existe wallet para o player nesta moeda',
            },
          ),
          '413': R413,
          '503': R503,
        },
      },
    },
    '/wallets/{walletId}': {
      get: {
        tags: ['Wallets'],
        operationId: 'getWallet',
        summary: 'Consulta wallet (saldo e versão)',
        parameters: [walletIdParam, correlationParam],
        responses: {
          '200': ok('Wallet.', ref('Wallet')),
          '400': R400,
          '404': R404Wallet,
          '503': R503,
        },
      },
    },
    '/wallets/{walletId}/ledger': {
      get: {
        tags: ['Wallets'],
        operationId: 'getLedger',
        summary: 'Lista lançamentos do ledger',
        description:
          'Paginação por cursor **opaco e estável** (baseado na ordem total do ledger). Use o `nextCursor` da resposta; `null` = fim. O ledger é append-only: páginas já lidas não mudam.',
        parameters: [
          walletIdParam,
          {
            name: 'cursor',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Cursor opaco devolvido pela página anterior.',
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
          correlationParam,
        ],
        responses: {
          '200': ok('Página do ledger.', ref('LedgerPage')),
          '400': R400,
          '404': R404Wallet,
          '503': R503,
        },
      },
    },
    '/wallets/{walletId}/reconciliation': {
      post: {
        tags: ['Wallets'],
        operationId: 'reconcileWallet',
        summary: 'Reconcilia saldo armazenado × ledger',
        description:
          'Compara `wallets.balance` com a soma com sinal de todos os lançamentos. Divergência é logada, contada em `reconciliation_divergence_total` e sinalizada com `consistent: false` — **nunca corrigida**.',
        parameters: [walletIdParam, correlationParam],
        responses: {
          '200': ok('Resultado da reconciliação (consistente ou não).', ref('Reconciliation'), {
            consistente: {
              summary: 'Consistente',
              value: {
                walletId: EX_WALLET,
                storedBalance: { amount: '975.00', currency: 'BRL' },
                calculatedBalance: { amount: '975.00', currency: 'BRL' },
                difference: { amount: '0.00', currency: 'BRL' },
                consistent: true,
                checkedEntries: 42,
              },
            },
          }),
          '400': R400,
          '404': R404Wallet,
          '503': R503,
        },
      },
    },
    '/wagering/transactions': {
      post: {
        tags: ['Wagering'],
        operationId: 'submitWagerTransaction',
        summary: 'Submete transação de aposta',
        description: [
          'Mesmo use case do consumidor SQS. O status HTTP diz ao provedor o que fazer:',
          '',
          '| Status | Situação | Reenviar? |',
          '|---|---|---|',
          '| 201 | processada (primeira vez) | não |',
          '| 200 | replay idêntico (`idempotentReplay: true`) | não |',
          '| 202 | `PENDING_REFERENCE`: referência ainda não chegou | não; consultar por GET |',
          '| 422 | rejeição de negócio (`failureCode`); replay = o mesmo 422 | conforme o código |',
          '| 400 | payload/header inválido | só após corrigir |',
          '| 409 | mesma key com payload diferente, ou mesmo externalTransactionId com outra key | não |',
          '| 404 | wallet inexistente | só após corrigir |',
          '| 403 | principal não autorizado para o provedor (com autenticação habilitada) | não |',
          '| 413 | corpo acima de 100 KB | só após corrigir |',
          '| 500 | falha permanente inesperada (`FAILED`, auditável) | não sem investigação |',
          '| 503 | falha transitória (`Retry-After`) | sim, com a mesma key |',
          '',
          '**Regras:** BET debita (ou `INSUFFICIENT_FUNDS`); WIN credita (pode referenciar a BET); LOSS não move saldo (aceita 0.00); REFUND reverte uma BET; ROLLBACK reverte BET, WIN ou REFUND. Reversões exigem `referenceExternalTransactionId`, mesmo valor, mesmo provider/player/wallet/moeda/rodada e só uma reversão por referência (D1).',
        ].join('\n'),
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: TEXT,
            description:
              'Fonte da verdade da idempotência. Recomendado: `{providerId}:{externalTransactionId}`.',
            example: 'provider-a:transaction-123',
          },
          correlationParam,
        ],
        requestBody: {
          required: true,
          content: json(ref('SubmitWagerRequest'), {
            bet: { summary: 'BET 25.00', value: wagerExample('BET', '25.00', 'transaction-123') },
            win: {
              summary: 'WIN referenciando a BET',
              value: wagerExample('WIN', '50.00', 'transaction-124', 'transaction-123'),
            },
            loss: {
              summary: 'LOSS (sem movimento)',
              value: wagerExample('LOSS', '0.00', 'transaction-125'),
            },
            refund: {
              summary: 'REFUND da BET',
              value: wagerExample('REFUND', '25.00', 'transaction-126', 'transaction-123'),
            },
            rollback: {
              summary: 'ROLLBACK da BET',
              value: wagerExample('ROLLBACK', '25.00', 'transaction-127', 'transaction-123'),
            },
          }),
        },
        responses: {
          '201': ok('Processada pela primeira vez.', ref('WagerResult'), {
            processada: {
              summary: 'PROCESSED',
              value: {
                transactionId: EX_TX,
                status: 'PROCESSED',
                balance: { amount: '975.00', currency: 'BRL' },
                idempotentReplay: false,
              },
            },
          }),
          '200': ok(
            'Replay idêntico: resultado original, com o saldo observado na época.',
            ref('WagerResult'),
            {
              replay: {
                summary: 'Replay',
                value: {
                  transactionId: EX_TX,
                  status: 'PROCESSED',
                  balance: { amount: '975.00', currency: 'BRL' },
                  idempotentReplay: true,
                },
              },
            },
          ),
          '202': ok(
            'Aceita; aguardando a transação referenciada (PENDING_REFERENCE). Traz o saldo atual (D6).',
            ref('WagerResult'),
            {
              pendente: {
                summary: 'PENDING_REFERENCE',
                value: {
                  transactionId: EX_TX,
                  status: 'PENDING_REFERENCE',
                  balance: { amount: '1000.00', currency: 'BRL' },
                  idempotentReplay: false,
                },
              },
            },
          ),
          '422': ok(
            'Rejeitada por regra de negócio (REJECTED, auditável). O `failureCode` diz o que fazer.',
            ref('WagerResult'),
            {
              semSaldo: {
                summary: 'INSUFFICIENT_FUNDS',
                value: {
                  transactionId: EX_TX,
                  status: 'REJECTED',
                  failureCode: 'INSUFFICIENT_FUNDS',
                  balance: { amount: '20.00', currency: 'BRL' },
                  idempotentReplay: false,
                },
              },
            },
          ),
          '400': R400,
          '404': R404Wallet,
          '409': errorResponse(
            'Conflito de idempotência (`IDEMPOTENCY_CONFLICT`) — erro do provedor, não replay.',
            {
              error: 'IDEMPOTENCY_CONFLICT',
              message: 'Idempotency-Key já usada com payload diferente',
            },
          ),
          '403': R403,
          '413': R413,
          '500': {
            description:
              'Falha permanente inesperada. Normalmente a transação fica gravada como `FAILED` (`INTERNAL_PERMANENT_ERROR`) e o corpo é um `WagerResult`; se nem isso foi possível, o corpo é `Error`.',
            headers: { 'X-Correlation-Id': { $ref: '#/components/headers/CorrelationId' } },
            content: json({ oneOf: [ref('WagerResult'), ref('Error')] }),
          },
          '503': R503,
        },
      },
    },
    '/wagering/transactions/{transactionId}': {
      get: {
        tags: ['Wagering'],
        operationId: 'getTransaction',
        summary: 'Consulta transação pelo id interno',
        parameters: [
          { name: 'transactionId', in: 'path', required: true, schema: UUID },
          correlationParam,
        ],
        responses: {
          '200': ok('Transação.', ref('Transaction')),
          '400': R400,
          '404': R404Tx,
          '503': R503,
        },
      },
    },
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
      get: {
        tags: ['Wagering'],
        operationId: 'getTransactionByExternalId',
        summary: 'Consulta transação pela identidade no provedor',
        parameters: [
          { name: 'providerId', in: 'path', required: true, schema: TEXT },
          { name: 'externalTransactionId', in: 'path', required: true, schema: TEXT },
          correlationParam,
        ],
        responses: { '200': ok('Transação.', ref('Transaction')), '404': R404Tx, '503': R503 },
      },
    },
    '/health/live': {
      get: {
        tags: ['Operação'],
        operationId: 'liveness',
        summary: 'Liveness (processo vivo; não consulta dependências)',
        responses: { '200': ok('Vivo.', ref('HealthLive')) },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Operação'],
        operationId: 'readiness',
        summary: 'Readiness (PostgreSQL e SQS alcançáveis)',
        responses: {
          '200': ok('Pronto.', ref('HealthReady')),
          '503': ok('Alguma dependência indisponível.', ref('HealthReady')),
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['Operação'],
        operationId: 'metrics',
        summary: 'Métricas Prometheus',
        description:
          '`wager_transactions_total{kind,status}`, `wager_duplicates_total`, `wager_retries_total`, `wager_dlq_messages_total{reason}`, `wager_lock_conflicts_total`, `wager_processing_duration_seconds{source}`, `outbox_pending_total`, `outbox_lag_seconds`, `outbox_overdue_total`, `reconciliation_divergence_total` e métricas padrão do processo.',
        responses: {
          '200': {
            description: 'Formato de exposição Prometheus.',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      },
    },
  },
  components: {
    parameters: {
      CorrelationId: {
        name: 'X-Correlation-Id',
        in: 'header',
        required: false,
        schema: { type: 'string', pattern: '^[\\w.:-]{1,128}$' },
        description:
          'Id de correlação (gerado se ausente ou inválido); propagado para logs e eventos.',
      },
    },
    headers: {
      CorrelationId: {
        description: 'Id de correlação desta requisição.',
        schema: { type: 'string' },
      },
    },
    schemas: {
      MoneyProps: {
        type: 'object',
        description:
          'Valor monetário exato: string decimal com 2 casas (nunca número) + moeda ISO-4217.',
        required: ['amount', 'currency'],
        additionalProperties: false,
        properties: {
          amount: { type: 'string', pattern: '^-?(0|[1-9]\\d{0,15})\\.\\d{2}$', example: '25.00' },
          currency: { type: 'string', pattern: '^[A-Z]{3}$', example: 'BRL' },
        },
      },
      MoneyInput: {
        type: 'object',
        description:
          'Valor de entrada: string decimal não negativa com 0 a 2 casas (normalizada para 2; nada é arredondado). Recusa número, NaN, Infinity, notação científica e mais de 2 casas.',
        required: ['amount', 'currency'],
        properties: {
          amount: {
            type: 'string',
            pattern: '^(0|[1-9]\\d{0,15})(\\.\\d{1,2})?$',
            example: '25.00',
          },
          currency: { type: 'string', pattern: '^[A-Z]{3}$', example: 'BRL' },
        },
      },
      CreateWalletRequest: {
        type: 'object',
        required: ['playerId', 'initialBalance'],
        properties: { playerId: UUID, initialBalance: ref('MoneyInput') },
      },
      Wallet: {
        type: 'object',
        required: ['id', 'playerId', 'balance', 'version'],
        additionalProperties: false,
        properties: {
          id: UUID,
          playerId: UUID,
          balance: ref('MoneyProps'),
          version: {
            type: 'integer',
            minimum: 1,
            description: 'Começa em 1 e incrementa só quando o saldo muda.',
          },
        },
      },
      SubmitWagerRequest: {
        type: 'object',
        required: [
          'providerId',
          'externalTransactionId',
          'playerId',
          'walletId',
          'roundId',
          'gameId',
          'kind',
          'money',
        ],
        properties: {
          providerId: TEXT,
          externalTransactionId: TEXT,
          playerId: UUID,
          walletId: UUID,
          roundId: TEXT,
          gameId: TEXT,
          kind: {
            type: 'string',
            enum: [...SUBMITTABLE_KINDS],
            description: 'OPENING é interno e não pode ser submetido.',
          },
          money: ref('MoneyInput'),
          referenceExternalTransactionId: {
            ...TEXT,
            description:
              'Id da transação referenciada NO PROVEDOR. Obrigatório para REFUND e ROLLBACK; opcional para WIN.',
          },
        },
      },
      TransactionStatus: { type: 'string', enum: Object.values(WagerTransactionStatus) },
      FailureCode: {
        type: 'string',
        enum: Object.values(FailureCode),
        description: `Código estável e legível por máquina:\n\n${failureCodeDescription}`,
      },
      WagerResult: {
        type: 'object',
        required: ['transactionId', 'status', 'balance', 'idempotentReplay'],
        additionalProperties: false,
        properties: {
          transactionId: UUID,
          status: ref('TransactionStatus'),
          balance: {
            ...ref('MoneyProps'),
            description:
              'Saldo observado quando a transação ficou terminal (o replay devolve o mesmo); em PENDING_REFERENCE, o saldo atual.',
          },
          failureCode: ref('FailureCode'),
          idempotentReplay: { type: 'boolean' },
        },
      },
      Transaction: {
        type: 'object',
        additionalProperties: false,
        required: [
          'transactionId',
          'providerId',
          'externalTransactionId',
          'walletId',
          'playerId',
          'roundId',
          'gameId',
          'kind',
          'status',
          'money',
          'referenceExternalTransactionId',
          'referenceTransactionId',
          'failureCode',
          'observedBalance',
          'createdAt',
          'processedAt',
        ],
        properties: {
          transactionId: UUID,
          providerId: { type: 'string' },
          externalTransactionId: { type: 'string' },
          walletId: UUID,
          playerId: UUID,
          roundId: { type: 'string' },
          gameId: { type: 'string' },
          kind: { type: 'string', enum: Object.values(WagerTransactionKind) },
          status: ref('TransactionStatus'),
          money: ref('MoneyProps'),
          referenceExternalTransactionId: { type: ['string', 'null'] },
          referenceTransactionId: { oneOf: [UUID, { type: 'null' }] },
          failureCode: { oneOf: [ref('FailureCode'), { type: 'null' }] },
          observedBalance: { oneOf: [ref('MoneyProps'), { type: 'null' }] },
          createdAt: { type: 'string', format: 'date-time' },
          processedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      LedgerEntry: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'transactionId',
          'direction',
          'money',
          'balanceBefore',
          'balanceAfter',
          'createdAt',
        ],
        properties: {
          id: UUID,
          transactionId: UUID,
          direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
          money: ref('MoneyProps'),
          balanceBefore: ref('MoneyProps'),
          balanceAfter: ref('MoneyProps'),
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      LedgerPage: {
        type: 'object',
        additionalProperties: false,
        required: ['walletId', 'entries', 'nextCursor'],
        properties: {
          walletId: UUID,
          entries: { type: 'array', items: ref('LedgerEntry') },
          nextCursor: {
            type: ['string', 'null'],
            description: 'Cursor da próxima página; null = fim.',
          },
        },
      },
      Reconciliation: {
        type: 'object',
        additionalProperties: false,
        required: [
          'walletId',
          'storedBalance',
          'calculatedBalance',
          'difference',
          'consistent',
          'checkedEntries',
        ],
        properties: {
          walletId: UUID,
          storedBalance: ref('MoneyProps'),
          calculatedBalance: ref('MoneyProps'),
          difference: ref('MoneyProps'),
          consistent: { type: 'boolean' },
          checkedEntries: { type: 'integer', minimum: 0 },
        },
      },
      Error: {
        type: 'object',
        additionalProperties: false,
        required: ['error', 'message'],
        properties: {
          error: {
            type: 'string',
            description:
              'INVALID_PAYLOAD · WALLET_NOT_FOUND · TRANSACTION_NOT_FOUND · WALLET_ALREADY_EXISTS · IDEMPOTENCY_CONFLICT · PROVIDER_NOT_AUTHORIZED · PAYLOAD_TOO_LARGE · TRANSIENT_INFRASTRUCTURE_ERROR · NOT_FOUND · INTERNAL_ERROR',
          },
          message: { type: 'string' },
          details: {
            type: 'array',
            items: { type: 'string' },
            description: 'Campos inválidos (em 400).',
          },
        },
      },
      HealthLive: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: { status: { const: 'ok' } },
      },
      HealthReady: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'checks'],
        properties: {
          status: { type: 'string', enum: ['ok', 'unavailable'] },
          checks: {
            type: 'object',
            additionalProperties: false,
            required: ['postgres', 'sqs'],
            properties: {
              postgres: { type: 'string', enum: ['up', 'down'] },
              sqs: { type: 'string', enum: ['up', 'down'] },
            },
          },
        },
      },
    },
  },
} as const;
