# Auditoria final (Etapa 21)

Execução **do zero** em 2026-11-17, com Bun 1.4.4, Docker 29.8.1, PostgreSQL 17 e LocalStack 4.9:

1. `docker compose down -v` + `docker compose up -d --build` → as filas, as migrations e a app subiram sozinhas ([01-compose-up.txt](evidence/01-compose-up.txt)).
2. Fluxo ponta a ponta no compose recém-criado, por HTTP, SQS e outbox ([02-fluxo-e2e.txt](evidence/02-fluxo-e2e.txt), [02b-estado-banco.txt](evidence/02b-estado-banco.txt)).
3. Ataques diretos ao banco ([03-ledger-imutavel.txt](evidence/03-ledger-imutavel.txt)).
4. Verificações estáticas ([04-verificacoes-estaticas.txt](evidence/04-verificacoes-estaticas.txt)).
5. Formatação, lint, typecheck e build ([05-qualidade.txt](evidence/05-qualidade.txt)).
6. A suíte completa (unit + integration + concurrency) passou **3 vezes seguidas** com 251/251 testes, contra PostgreSQL e LocalStack reais e com a stack de dev no ar ao mesmo tempo ([06-testes-3x.txt](evidence/06-testes-3x.txt)). Uma 4ª execução, já com o código final, aparece em [07-testes-por-arquivo.txt](evidence/07-testes-por-arquivo.txt), com o nome de cada teste.

## Falhas eliminatórias

| # | Falha eliminatória | Situação | Evidência |
|---|---|---|---|
| 1 | `number` para dinheiro | ✅ ausente | `Money` sobre `decimal.js`; colunas `NUMERIC(18,2)`; `DecimalType('string')`. Os greps de [04](evidence/04-verificacoes-estaticas.txt) não acharam `parseFloat`, `toNumber()`, `Number(amount…)`, campos monetários `: number` nem float/double no schema. Os testes `architecture.test.ts › Restrição #1` e `money.test.ts` (27) recusam `amount: 25` como number, `1e3`, NaN, Infinity e 3 casas. Contratos HTTP/SQS/eventos usam sempre `MoneyProps` (string). |
| 2 | Saldo negativo causado por race | ✅ impossível | Lock `FOR UPDATE` por wallet antes de ler o saldo, mais `CHECK (balance >= 0)` e `CHECK (balance_after >= 0)` no banco. Testes: `submit-wager › 100.00 + 2×BET 80.00 simultâneas` e `hot wallet: 30 BETs` (em processo); `multi-instance › 2.` (BETs em instâncias diferentes: 1×201, 1×422, saldo 20.00). O mesmo cenário rodou no compose ([02](evidence/02-fluxo-e2e.txt): 201 + 422, saldo 20.00). Um INSERT direto com saldo negativo é recusado ([03](evidence/03-ledger-imutavel.txt)). A invariante `balance_before/after >= 0` é conferida ao fim de todo teste. |
| 3 | Débito ou crédito duplicado | ✅ impossível | `UNIQUE (provider, external_id)`, `UNIQUE (provider, idempotency_key)`, `UNIQUE (wallet_id, transaction_id)` no ledger e o índice D1 de reversão única. Testes: `submit-wager › mesma aposta 50× em paralelo` e `multi-instance › 1.` (50×, 3 instâncias: 1 débito, 49 replays); `crash-recovery › 5.` (crash entre commit e ack: 1 efeito); `sqs-consumer › redelivery` e `mesma operação em messageIds diferentes`; `schema-constraints › uq_*`. A invariante "nenhum lançamento duplicado por transação" é conferida em todos. |
| 4 | Idempotência apenas em memória | ✅ persistente | UNIQUEs no banco + `inbox_messages` gravada no mesmo commit. O grep de [04](evidence/04-verificacoes-estaticas.txt) não acha cache: só dois `Set` constantes de códigos de erro e um `Set` local de uma iteração da outbox. A idempotência sobrevive a reinício e a instâncias diferentes (`multi-instance › 1.`, `crash-recovery › 5.` e `8.`). |
| 5 | Correto somente com uma instância | ✅ correto com ≥ 3 | `multi-instance.test.ts`: 3 **processos reais** (`Bun.spawn`) no mesmo banco e nas mesmas filas. As três instâncias consumiram a fila e as três publicaram a outbox; 368 eventos foram entregues sem perda nem duplicata. Locks no banco, `SKIP LOCKED` na outbox e nas pendências, `ON CONFLICT` na inbox ([06](evidence/06-testes-3x.txt), linhas "cenário 4/6"). |
| 6 | Publicação de evento antes do commit | ✅ impossível | O único publisher de eventos é o worker da outbox, e o worker só lê linhas comitadas. Os dois `SendMessageCommand` do código são o publisher de eventos e o envio explícito à **DLQ** pelo consumidor ([04](evidence/04-verificacoes-estaticas.txt)). Testes: `outbox › nada é publicado antes do worker rodar`; `outbox › evento só existe se a transação comitar`; `atomicity › falha ao gravar o evento desfaz débito, lançamento e inbox`. |
| 7 | Ausência de ledger auditável | ✅ presente e imutável | `wallet_ledger_entries` é append-only, com `CHECK ck_ledger_balanced`, `seq` identity e triggers que bloqueiam UPDATE, DELETE e TRUNCATE. No compose, os três comandos foram recusados ([03](evidence/03-ledger-imutavel.txt)). Testes: `schema-constraints › Restrição #5`. A reconciliação (`POST /wallets/:id/reconciliation`) bate o saldo com o ledger ([02](evidence/02-fluxo-e2e.txt): `consistent: true`) e sinaliza divergência forçada sem corrigir (`reconciliation.test.ts`). |
| 8 | Testes que substituem PostgreSQL e SQS por mocks | ✅ nenhum mock | Todos os testes de integração e concorrência usam o PostgreSQL e o LocalStack dos containers (`test/support/database.ts`, `test/support/sqs.ts`). Não existe mock, stub nem fake de banco ou fila no repositório. As falhas são reais: triggers de teste no PostgreSQL, conexões segurando locks, endpoint SQS inalcançável, `SIGKILL` em processos. |

## Checklist complementar (guia §17, Etapa 21)

| Item | ✅ | Evidência |
|---|---|---|
| `docker compose up` sobe PostgreSQL, LocalStack (3 filas + redrive), aplica migrations e inicia a app | ✅ | [01](evidence/01-compose-up.txt) |
| Migrations versionadas e reversíveis (up/down reais) | ✅ | `migration.test.ts` (up → down sem tabelas nem função → up de novo; UP idêntico ao `001_initial_schema.sql`) |
| Unicidade, imutabilidade e não-negatividade no schema (Restrição #9) | ✅ | `schema-constraints.test.ts`: 30 testes, um por constraint, índice ou trigger |
| Sem lock global (Restrição #6) | ✅ | grep sem advisory lock, `LOCK TABLE` nem mutex ([04](evidence/04-verificacoes-estaticas.txt)); `locking › wallets distintas`; `multi-instance › 3.` (100 operações concluem com outra wallet travada) |
| Nunca read→calculate→update sem lock (Restrição #7) | ✅ | `locking › mesma wallet: a segunda transação espera o commit da primeira` (lê 70.00, não 100.00) |
| Não depender só de SQS FIFO (Restrição #3) | ✅ | duplicatas com dedup ids e messageIds diferentes → 1 efeito (`sqs-consumer`, `multi-instance › 4.`, [02](evidence/02-fluxo-e2e.txt)) |
| Ack só após o commit | ✅ | `crash-recovery › 5.` (morte após o commit: a mensagem continua na fila; a redelivery vira replay) |
| Retry com backoff, DLQ, limite de tentativas | ✅ | `sqs-consumer › transitório…`, `payload inválido`, `wallet inexistente`, `última tentativa… RETRY_LIMIT_EXCEEDED` |
| SIGTERM sem perder mensagem | ✅ | `crash-recovery › SIGTERM`, `sqs-consumer › SIGTERM`; no container, saída graciosa após concluir o long poll |
| Recuperação após reinício | ✅ | `crash-recovery › 8.` (`kill -9` com 15–18 de 30 processadas; a nova instância conclui, a reconciliação dá `consistent` e a outbox é drenada) |
| PENDING_REFERENCE (fora de ordem, backoff, TTL, limite) | ✅ | `pending-reference.test.ts` (8), `multi-instance › 7.` |
| Um teste HTTP real por linha da tabela de status | ✅ | `http-api.test.ts`: 201, 200, 202, 422, 400, 409, 404, 500, 503 + `Retry-After` |
| Observabilidade (logs correlacionados, métricas, health) | ✅ | `observability.test.ts`, `health-live.test.ts`; logs JSON do compose em [02](evidence/02-fluxo-e2e.txt) |
| Invariante final em todos os testes | ✅ | `test/support/invariants.ts`, chamado no `afterEach` de toda suíte com banco |
| Suíte de concorrência estável em ≥ 3 execuções | ✅ | [06](evidence/06-testes-3x.txt) (e mais 3 execuções só da suíte de concorrência durante a Etapa 18) |
| TypeScript estrito, sem `any` | ✅ | `strict: true` + `noUncheckedIndexedAccess`; ESLint `strictTypeChecked` com `no-explicit-any` sem erros ([05](evidence/05-qualidade.txt)); grep de `any` vazio ([04](evidence/04-verificacoes-estaticas.txt)) |

> **Atualização:** depois desta auditoria entraram o teste de queda do PostgreSQL ([CONFORMIDADE.md](CONFORMIDADE.md)), o teste de contrato do OpenAPI (Swagger) e a suíte de abuso/segurança ([SEGURANCA.md](SEGURANCA.md)). A suíte atual tem **291 testes, todos passando**. As evidências acima são da execução da Etapa 21 (251 testes).

## Etapa 22 e o que não foi feito

- **Etapa 22 (teste de carga, opcional):** feita depois desta auditoria; ver [LOAD_TEST.md](LOAD_TEST.md). A versão atual é progressiva (6 → 96 usuários) com personas (agressivo, moderado, conservador): 0% de erro, invariantes preservadas e outbox lag crescente com a carga (gargalo documentado, sem perda de eventos).
- **Autenticação**: não implementada, por decisão documentada ([ARCHITECTURE.md §11](../ARCHITECTURE.md#11-autenticação-extensão-não-implementada)), com `AuthGuard` no-op e `ProviderIdentityPort` stub como pontos de extensão.
