# Verificação de conformidade com o enunciado

Verificação feita em 2026-11-17, cruzando cada seção do enunciado com o código, os testes e a execução real:

- **Qualidade:** `format:check`, `lint` e `tsc` sem erros.
- **Testes:** `bun test` com 252/252 contra PostgreSQL e LocalStack reais.
- **Compose:** checagens manuais na stack em execução.

Legenda: ✅ conforme · 🔧 lacuna encontrada nesta verificação e corrigida.

## Resultado

| § | Exigência | Situação | Onde |
|---|---|---|---|
| 2 | Autenticação opcional; se não implementada: decisão documentada + ponto de extensão; health aberto; fila como canal confiável, com validação de domínio do provedor | ✅ | `ARCHITECTURE.md §11`; `auth.guard.ts` (no-op, fora de health/metrics); `ProviderIdentityPort` injetada no use case |
| 4 | Bun 1.x, TS estrito, NestJS, PostgreSQL, SQS/LocalStack, Compose, migrations versionadas e reversíveis, MikroORM (sem Prisma/TypeORM) | ✅ | `package.json`, `tsconfig.json` (`strict`), `docker-compose.yml`, `migrations/`, `migration.test.ts` |
| 5.1 | Sem `number`/float/double para dinheiro | ✅ | `Money` (`decimal.js`), `NUMERIC(18,2)`, `architecture.test.ts`, `docs/evidence/04` |
| 5.2 | Sem cache em memória para idempotência | ✅ | UNIQUEs + `inbox_messages`; `docs/evidence/04` |
| 5.3 | Não depender só do SQS FIFO | ✅ | `sqs-consumer.test.ts` (dedup ids/messageIds diferentes), `multi-instance › 4.` |
| 5.4 | Evento só depois do commit | ✅ | Transactional Outbox; `outbox.test.ts`, `atomicity.test.ts` |
| 5.5 | Ledger sem UPDATE/DELETE | ✅ | triggers row + TRUNCATE; `schema-constraints › Restrição #5`, `docs/evidence/03` |
| 5.6 | Sem lock global | ✅ | `FOR UPDATE` por wallet; `locking › wallets distintas`, `multi-instance › 3.` |
| 5.7 | Sem read→calculate→update sem controle | ✅ | lock antes de ler o saldo; `locking › mesma wallet` |
| 5.8 | Correto com múltiplas instâncias | ✅ | `test/concurrency/*` (3 processos reais) |
| 5.9 | Garantias no schema | ✅ | `001_initial_schema.sql` verbatim; `schema-constraints.test.ts` (30 testes) |
| 6.0 | Construtor privado/protegido + factories; `rehydrate` sem revalidar | ✅ | todas as classes de domínio (`private constructor`; `IntegrationEvent` com `protected`) |
| 6.1 | `Money`: API, imutável, 2 casas, moedas diferentes → erro, entradas inválidas rejeitadas, domínio sem tipos do ORM | ✅ | `money.ts`, `money.test.ts` (27) |
| 6.2 | `Wallet`: uma por player+moeda, saldo ≥ 0, saldo ↔ ledger, sem lost update, moeda igual, `version` 1 e só incrementa com o saldo | ✅ | `wallet.ts`, `wallet.test.ts`, `uq_wallets_player_currency` |
| 6.3 | `WagerTransaction`: enums, estados terminais (erro de programação), OPENING interno, key com payload diferente = conflito, **transições definidas e documentadas** | 🔧 | estava documentado só no código; a tabela foi adicionada em `ARCHITECTURE.md §1.1`; `wager-transaction.test.ts` cobre cada transição |
| 6 | Assinaturas adaptadas (permitido) | 🔧 | adaptações listadas e justificadas em `ARCHITECTURE.md §1.2` |
| 6.4 | `WalletLedgerEntry` imutável estruturalmente; `create` valida a aritmética; no máximo 1 lançamento por wallet/transação; LOSS/REJECTED sem lançamento | ✅ | `wallet-ledger-entry.ts` (+ teste de ausência de setters), `ck_ledger_balanced`, `uq_ledger_wallet_tx` |
| 6.5 | Inbox/Outbox com a API do enunciado; mesma transação SQL | ✅ | `inbox-message.ts`, `outbox-message.ts`, `atomicity.test.ts` |
| 7 | Efeitos por operação e regras 1–9 | ✅ | `wager-settlement.ts`, `wager-settlement.test.ts` (28); regra 4 interpretada como D1 (documentada) |
| 7.1 | Worker agendado com backoff; TTL/limite justificados; esgotado → REJECTED + evento | ✅ | `pending-reference-processor.ts`, `pending-reference.test.ts` |
| 7.2 | Taxonomia de `failureCode` definida e documentada | ✅ | `failure-code.ts`, `ARCHITECTURE.md §6` |
| 8 | Unidade de concorrência = wallet; ≥ 3 instâncias; estratégia justificada; cenário 100/80/80 | ✅ | `ARCHITECTURE.md §3`; `submit-wager.test.ts`, `multi-instance › 2.`, `docs/evidence/02` |
| 9 | Todas as rotas e contratos; wallet duplicada = conflito; idempotência (header obrigatório, hash canônico documentado, replay, conflito); status HTTP distintos e consistentes; reconciliação sem autocorreção; health sem autenticação | ✅ | controllers; `http-api.test.ts` (uma linha da tabela por teste); `reconciliation.test.ts`; `ARCHITECTURE.md §4` |
| 10 | Filas com os nomes do enunciado; mesmo use case; inbox; ack pós-commit; negócio/transitório/permanente; limite antes da DLQ; SIGTERM; redelivery sem duplicar | ✅ | `01-create-queues.sh`; `sqs-wager-consumer.ts`; `sqs-consumer.test.ts`; `crash-recovery.test.ts` |
| 11 | Atomicidade; worker com publishers concorrentes; crash entre commit e publicação; 4 eventos mínimos; envelope abstrato com `eventType`/`version` no tipo; `data` com `MoneyProps` | ✅ | `wager-events.ts`, `integration-event.ts`, `outbox.test.ts`, `multi-instance › 6.` |
| 12 | Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; sem payload financeiro; métricas mínimas; liveness/readiness | 🔧 | os logs do consumidor SQS não tinham `correlationId`. Corrigido: o `messageId` passa a ir também como `correlationId`, o mesmo valor propagado aos eventos. Verificado na stack do compose. Métricas e health em `observability.test.ts` e `health-live.test.ts` |
| 3 | PostgreSQL e SQS temporariamente indisponíveis | 🔧 | a queda do SQS já tinha teste; a do PostgreSQL não. Novo `database-outage.test.ts`: o banco cai (proxy TCP) e a app responde liveness 200, readiness 503, 503 + `Retry-After`, sem gravar nada; o banco volta, a app se recupera sozinha e o reenvio aplica o efeito 1×. Também verificado parando o container do PostgreSQL |
| 13 | Unidade, integração (infra real) e os 8 cenários de concorrência; invariante final em todos | ✅ | mapeamento automático dos 24 itens exigidos para nomes de teste: 0 itens sem cobertura; `test/support/invariants.ts` |
| 14 | Falhas eliminatórias | ✅ | `docs/AUDITORIA.md` |
| 14 | Teste de carga (`bun run test:load`) com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos e outbox lag | ✅ | `docs/LOAD_TEST.md` |

## Alterações feitas nesta verificação

1. `ARCHITECTURE.md`: novas seções §1.1 (máquina de estados) e §1.2 (adaptações de assinatura).
2. `src/infrastructure/messaging/sqs-wager-consumer.ts`: `correlationId` nos logs do consumidor.
3. `test/integration/database-outage.test.ts`: queda e volta do PostgreSQL. A suíte passa de 251 para 252 testes.

---

## Segunda verificação (2026-11-18): conformidade e escopo

Feita depois da entrada do Swagger, da suíte de abuso e da carga com personas, para confirmar duas coisas: que o código continua atendendo ao enunciado e que nenhum acréscimo fugiu do que foi pedido.

**Conformidade**

- **Qualidade:** `format:check`, `lint`, `tsc` e `build` sem erros.
- **Testes:** `bun test` com **291/291**.
- **Contratos byte a byte:** os exemplos literais do enunciado foram enviados à stack do compose e o formato das respostas foi comparado campo a campo. `POST /wallets`, a submissão, o replay e a reconciliação são idênticos aos do §9, e a mensagem SQS literal do §10 é aceita pelo parser.
- **Mapeamento automático:** 28 grupos de exigência (§3 e §5 a §13) cruzados com os nomes dos testes que passaram. Nenhum ficou sem cobertura.

**Escopo: o que foi além do enunciado, e por que não conflita**

| Acréscimo | Origem | Conflita com o enunciado? |
|---|---|---|
| Fila `wager-events.fifo` | Guia (D8) | Não: o enunciado define as filas de entrada, não proíbe uma fila de saída |
| Códigos `BALANCE_LIMIT_EXCEEDED` (422), `PROVIDER_NOT_AUTHORIZED` (403) e `PAYLOAD_TOO_LARGE` (413) | Suíte de abuso | Não: a taxonomia e o mapeamento HTTP são do candidato (§7.2, §9). O primeiro é registrado como E14; o 403 é o ponto de extensão de autenticação do §2 |
| Swagger (`/docs`) e collection do Postman | Escopo complementar | Não: documentação adicional, sem mudar contrato |
| Suíte de abuso (`test/security`) e carga com personas | Escopo complementar | Não: testes adicionais; a carga segue o formato do diferencial (§14) |
| Injeção de falha `FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK` | Etapa 18 (cenário 5 do §13) | Não: desligada por padrão, só para o teste de crash; documentada |
| Métodos de domínio extras (`fromInput`, `canAdd`, `canCredit`, `hasReference` etc.) | Implementação | Não: o §6 permite adaptar assinaturas; listados no ARCHITECTURE §1.2 |

**Lacunas encontradas nesta verificação (só documentação, já corrigidas)**

1. `BALANCE_LIMIT_EXCEEDED` estava na taxonomia, mas não registrado como interpretação adicional. Agora é a decisão **E14**.
2. `Money.canAdd` e `Wallet.canCredit` faltavam na tabela de adaptações de assinatura (ARCHITECTURE §1.2).
3. O 403 / `ProviderNotAuthorizedError` não aparecia na seção de autenticação (ARCHITECTURE §11).

