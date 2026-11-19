# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores de jogos.

A entrega é **at-least-once**: a mesma operação pode chegar duplicada, fora de ordem ou ao mesmo tempo em várias instâncias, e o processo pode morrer no meio. Mesmo assim, o serviço garante:

- **nunca** duplica crédito ou débito;
- **nunca** deixa saldo negativo;
- **nunca** perde um evento confirmado;
- **sempre** mantém o saldo da wallet igual ao saldo reconstruído pelo ledger.

**Stack:** Bun 1.x · TypeScript estrito · NestJS · PostgreSQL 17 · MikroORM 7 · AWS SQS (LocalStack) · Docker Compose

---

## Sumário

1. [Funcionalidades](#funcionalidades)
2. [Pré-requisitos](#pré-requisitos)
3. [Como executar](#como-executar)
4. [Swagger (documentação interativa)](#swagger-documentação-interativa)
5. [Postman](#postman)
6. [API](#api)
7. [Processamento pela fila (SQS)](#processamento-pela-fila-sqs)
8. [Testes](#testes)
9. [Variáveis de ambiente](#variáveis-de-ambiente)
10. [Estrutura do projeto](#estrutura-do-projeto)
11. [Documentação complementar](#documentação-complementar)
12. [Solução de problemas](#solução-de-problemas)

---

## Funcionalidades

- **Wallets:** uma por jogador e moeda. O saldo inicial gera uma transação interna `OPENING` e um lançamento de crédito, tudo na mesma transação SQL.
- **Ledger append-only:** todo movimento de saldo gera exatamente um lançamento. O banco impede alterar ou apagar lançamentos.
- **Transações de aposta**, recebidas por HTTP ou pela fila SQS e processadas pelo mesmo use case:
  - BET debita;
  - WIN credita;
  - LOSS registra o resultado sem mexer no saldo;
  - REFUND e ROLLBACK revertem uma transação anterior, uma única vez.
- **Idempotência persistente:** o header `Idempotency-Key` é obrigatório. Repetir a requisição devolve o resultado original com `idempotentReplay: true`; mesma chave com outro conteúdo é conflito (409).
- **Referências fora de ordem:** um ROLLBACK ou REFUND que chega antes da transação referenciada fica em `PENDING_REFERENCE` (202) e é resolvido quando ela chega, com retentativas automáticas.
- **Transactional Outbox:** os eventos de integração são gravados na mesma transação do efeito e publicados depois em `wager-events.fifo`.
- **Reconciliação** de saldo × ledger, sem autocorreção.
- **Observabilidade:** logs JSON correlacionados, métricas Prometheus (`/metrics`), health checks e Swagger UI (`/docs`).

As decisões por trás de cada funcionalidade estão em [docs/DECISOES_E_FUNCIONALIDADES.md](docs/DECISOES_E_FUNCIONALIDADES.md) (resumo) e no [ARCHITECTURE.md](ARCHITECTURE.md) (detalhe).

---

## Pré-requisitos

| Ferramenta                 | Versão  | Para quê                                                                                   |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| Docker + Docker Compose v2 | recente | subir PostgreSQL, LocalStack e a aplicação                                                 |
| Bun                        | ≥ 1.1   | desenvolvimento local, testes e teste de carga (não é necessário só para rodar com Docker) |

Portas usadas: **3000** (API), **5432** (PostgreSQL) e **4566** (LocalStack).

---

## Como executar

### Opção 1 — tudo com Docker (recomendado)

```bash
docker compose up --build
```

O compose sobe, nesta ordem:

1. **postgres** e **localstack**. O script `docker/localstack/init/01-create-queues.sh` cria as filas `wager-transactions.fifo` (com redrive para a DLQ após 5 tentativas), `wager-transactions-dlq.fifo` e `wager-events.fifo`.
2. **migrate**: aplica as migrations e termina.
3. **app**: API HTTP na porta 3000, mais o consumidor SQS e os workers da outbox e de PENDING_REFERENCE.

Para conferir se está tudo no ar:

```bash
curl -s localhost:3000/health/ready
```

A resposta esperada é `{"status":"ok","checks":{"postgres":"up","sqs":"up"}}`. Depois disso, abra o Swagger em [http://localhost:3000/docs](http://localhost:3000/docs).

Para parar a stack:

```bash
docker compose down
```

Para parar e **apagar os dados** do banco (recomeçar do zero):

```bash
docker compose down -v
```

### Opção 2 — aplicação local com Bun (infraestrutura no Docker)

```bash
bun install
```

```bash
docker compose up -d --wait postgres localstack
```

```bash
bun run migrate:up
```

```bash
bun run dev
```

A app sobe em `http://localhost:3000` com reload automático. Os valores padrão da configuração já apontam para o PostgreSQL e o LocalStack locais. Para mudar algum, copie `.env.example` para `.env`, que o Bun carrega automaticamente.

### Scripts

| Script                                                                               | O que faz                                                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `bun run dev`                                                                        | sobe a app com reload                                                   |
| `bun run build` / `bun run start`                                                    | typecheck + bundle em `dist/` / roda o bundle                           |
| `bun run typecheck` · `bun run lint` · `bun run format`                              | TypeScript estrito · ESLint (`strictTypeChecked`, sem `any`) · Prettier |
| `bun run migrate:up` · `migrate:down` · `migrate:status`                             | migrations versionadas e reversíveis (MikroORM)                         |
| `bun run openapi:export`                                                             | regrava `docs/openapi.json` a partir do contrato no código              |
| `bun run test:infra`                                                                 | sobe PostgreSQL e LocalStack para os testes                             |
| `bun test` · `test:unit` · `test:integration` · `test:concurrency` · `test:security` | testes (ver [Testes](#testes))                                          |
| `bun run test:load`                                                                  | teste de carga contra a app rodando (ver [Testes](#testes))             |

---

## Swagger (documentação interativa)

Com a aplicação no ar:

| Endereço                                                                           | Conteúdo                                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [http://localhost:3000/docs](http://localhost:3000/docs)                           | **Swagger UI**: todas as rotas, schemas, status possíveis e exemplos   |
| [http://localhost:3000/docs/openapi.json](http://localhost:3000/docs/openapi.json) | contrato **OpenAPI 3.1** em JSON                                       |
| [docs/openapi.json](docs/openapi.json)                                             | o mesmo contrato, versionado no repositório (`bun run openapi:export`) |

**Como testar uma rota pelo Swagger:**

1. Abra `/docs` e expanda a rota (por exemplo `POST /wallets`).
2. Clique em **Try it out**.
3. Escolha um dos exemplos no seletor **Examples** e ajuste os campos. Em `POST /wagering/transactions`, preencha o header `Idempotency-Key`.
4. Clique em **Execute**. A resposta mostra o status, o corpo e os headers (inclusive `X-Correlation-Id`).

O spec é escrito à mão e mantido em sincronia com o código por um teste de contrato (`test/integration/openapi-contract.test.ts`). O teste falha se alguma rota existir sem documentação (ou o contrário), se alguma resposta real não bater com o schema documentado ou se o `docs/openapi.json` estiver desatualizado.

---

## Postman

Há duas formas de levar a API para o Postman.

### A) Collection pronta (recomendada para testar fluxos)

O arquivo [docs/postman/wagering.postman_collection.json](docs/postman/wagering.postman_collection.json) tem 33 requisições com os corpos prontos, organizadas em pastas (health, wallets, fluxo feliz, referência fora de ordem, erros). Cada requisição já confere o status esperado.

1. No Postman, clique em **Import** (canto superior esquerdo) ou use `Ctrl/Cmd + O`.
2. Arraste o arquivo `docs/postman/wagering.postman_collection.json` para a janela, ou clique em **files** e selecione-o.
3. Confirme em **Import**. A collection **Distributed Wagering Processor** aparece na barra lateral.
4. Rode primeiro **"1. Wallets › Criar wallet"**. Ela gera um `playerId` novo e guarda o `walletId`, que as outras requisições reaproveitam.
5. Depois, execute as pastas na ordem. Para rodar tudo de uma vez, clique com o botão direito na collection, escolha **Run collection** e depois **Run**.

O endereço da API fica na variável `baseUrl` da collection (padrão `http://localhost:3000`). Para mudar, clique na collection, abra a aba **Variables** e edite `baseUrl`.

Cada transação gera seu próprio `externalTransactionId`, então a collection pode ser executada quantas vezes quiser.

### B) Importar o contrato OpenAPI (gera uma collection com todas as rotas)

1. No Postman, clique em **Import**.
2. Escolha uma das opções:
   - **Arquivo:** arraste [docs/openapi.json](docs/openapi.json) para a janela;
   - **Link:** cole `http://localhost:3000/docs/openapi.json` (com a app no ar).
3. Quando o Postman perguntar como importar, escolha **Postman Collection** e clique em **Import**.
4. A collection gerada tem uma requisição por rota, com os exemplos do spec. O `baseUrl` já vem como `http://localhost:3000`; se a app estiver em outro endereço, edite a variável na aba **Variables**.

Nessa collection, os ids dos exemplos (`walletId`, `playerId`) são fixos. Crie uma wallet antes e troque o `walletId` no corpo das transações. A collection pronta (opção A) faz isso automaticamente.

O mesmo `docs/openapi.json` também pode ser importado no Insomnia ou no Bruno, ou usado para gerar clientes.

---

## API

Regras gerais:

- **Dinheiro** é sempre `{ "amount": "25.00", "currency": "BRL" }`: string decimal com 2 casas, nunca número.
- **`X-Correlation-Id`** (opcional) correlaciona a requisição nos logs e nos eventos. Se não for enviado, é gerado e devolvido na resposta.
- **Autenticação** não foi implementada; a decisão e o desenho estão no [ARCHITECTURE.md §11](ARCHITECTURE.md#11-autenticação-extensão-não-implementada).

| Método e rota                                                             | Função                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /wallets`                                                           | cria wallet (saldo inicial > 0 gera OPENING + CREDIT na mesma transação) |
| `GET /wallets/:walletId`                                                  | saldo e versão                                                           |
| `GET /wallets/:walletId/ledger?cursor=…&limit=50`                         | lançamentos, com cursor opaco e estável                                  |
| `POST /wallets/:walletId/reconciliation`                                  | saldo armazenado × reconstruído pelo ledger                              |
| `POST /wagering/transactions`                                             | submete transação (header `Idempotency-Key` obrigatório)                 |
| `GET /wagering/transactions/:transactionId`                               | consulta pelo id interno                                                 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pela identidade no provedor                                     |
| `GET /health/live` · `GET /health/ready`                                  | liveness · readiness (PostgreSQL e SQS)                                  |
| `GET /metrics`                                                            | métricas Prometheus                                                      |
| `GET /docs` · `GET /docs/openapi.json`                                    | Swagger UI · contrato OpenAPI 3.1                                        |

### Status HTTP

O status diz ao provedor o que fazer, sem precisar interpretar a mensagem de erro:

| Situação                                                                   | Status                         | Reenviar?                          |
| -------------------------------------------------------------------------- | ------------------------------ | ---------------------------------- |
| Processada (primeira vez)                                                  | 201                            | não                                |
| Replay idêntico                                                            | 200 + `idempotentReplay: true` | não                                |
| Aguardando referência (`PENDING_REFERENCE`)                                | 202                            | não; consultar por GET             |
| Rejeição de negócio (`failureCode` no corpo; o replay devolve o mesmo 422) | 422                            | conforme o código                  |
| Payload inválido / header ausente                                          | 400                            | só depois de corrigir              |
| Conflito de idempotência / wallet duplicada                                | 409                            | não                                |
| Wallet ou transação inexistente                                            | 404                            | só depois de corrigir              |
| Provedor não autorizado (quando a autenticação existir)                    | 403                            | não                                |
| Corpo acima de 100 KB                                                      | 413                            | só depois de corrigir              |
| Falha permanente inesperada (`FAILED`, auditável)                          | 500                            | não sem investigação               |
| Falha transitória (banco/SQS fora, lock ocupado)                           | 503 + `Retry-After`            | sim, com a mesma `Idempotency-Key` |

Os códigos de falha e o que cada um significa estão no [ARCHITECTURE.md §6](ARCHITECTURE.md#6-taxonomia-de-falhas-e-status-http) e no Swagger (schema `FailureCode`).

### Exemplos com curl

Criar uma wallet:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Resposta (201): `{"id":"<walletId>","playerId":"0192f28f-…","balance":{"amount":"100.00","currency":"BRL"},"version":1}`

Submeter uma aposta (troque `<walletId>`):

```bash
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Resposta (201): `{"transactionId":"…","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}`. Repetir a mesma requisição devolve 200 com `"idempotentReplay":true`.

Reconciliar a wallet:

```bash
curl -s -X POST localhost:3000/wallets/<walletId>/reconciliation
```

Resposta (200): `{"walletId":"…","storedBalance":{…},"calculatedBalance":{…},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":2}`

---

## Processamento pela fila (SQS)

A mesma operação pode ser enviada pela fila `wager-transactions.fifo`, e o resultado é idêntico ao da entrada HTTP. Use o `walletId` como `MessageGroupId` (ordem por wallet):

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

Para ver os eventos publicados pela outbox:

```bash
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-events.fifo --max-number-of-messages 10
```

Mensagens inválidas ou de wallet inexistente vão para `wager-transactions-dlq.fifo`, com o motivo no atributo `failureReason`.

---

## Testes

```bash
bun run test:infra
```

```bash
bun test
```

O primeiro comando sobe o PostgreSQL e o LocalStack reais; nenhum teste usa mock de banco ou de fila. O segundo roda as quatro suítes (291 testes):

| Suíte        | Pasta              | Precisa de infra? | O que cobre                                                                                                                                                                                                                                                   |
| ------------ | ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unitária     | `test/unit`        | não               | Money, Wallet, ledger, máquina de estados, regras de negócio, hash canônico, eventos, guardas de arquitetura                                                                                                                                                  |
| Integração   | `test/integration` | sim               | migrations, uma tentativa de violação por constraint do schema, idempotência, atomicidade, outbox, consumidor SQS (DLQ, retry, SIGTERM), referências fora de ordem, reconciliação, queda do PostgreSQL, uma requisição HTTP real por status, contrato OpenAPI |
| Concorrência | `test/concurrency` | sim               | 3 instâncias reais da app (`Bun.spawn`), worker morto entre commit e ack, `kill -9` no meio do processamento, SIGTERM                                                                                                                                         |
| Segurança    | `test/security`    | sim               | 27 tentativas de burlar o sistema (corridas de saque, reversão dupla simultânea, mass assignment, SQL injection, valores malformados, referência de outro jogador ou provedor) — mapa em [docs/SEGURANCA.md](docs/SEGURANCA.md)                               |

- Os testes usam um banco próprio (`wagering_test`) e filas próprias (`*-test.fifo`), então podem rodar com a app do compose no ar.
- Todo teste com banco termina conferindo, direto no PostgreSQL: saldo == ledger, nenhum lançamento duplicado e nenhum saldo negativo.

Teste de carga progressivo com personas (com a app no ar):

```bash
bun run test:load
```

Cada usuário virtual é um jogador com a própria wallet, num de três perfis:

- **agressivo:** apostas altas, rajadas simultâneas na própria wallet, muitos reenvios;
- **moderado:** valores médios, com REFUNDs;
- **conservador:** apostas pequenas, uma por vez.

A carga sobe em estágios (6 → 12 → 24 → 48 → 96 usuários) e termina com um estágio em que todos disputam a mesma wallet. O relatório [docs/LOAD_TEST.md](docs/LOAD_TEST.md) sai por estágio e por persona, com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, rejeições, conflitos de lock, outbox lag e onde o sistema satura. O comando termina com erro se alguma invariante for violada.

---

## Variáveis de ambiente

Todas têm valor padrão; a lista completa está em [.env.example](.env.example).

| Variável (padrão)                                                                                                                                           | Uso                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PORT` (3000) · `LOG_LEVEL` (info)                                                                                                                          | porta HTTP · nível do log JSON                                                                            |
| `DATABASE_HOST` · `DATABASE_PORT` · `DATABASE_NAME` · `DATABASE_USER` · `DATABASE_PASSWORD`                                                                 | PostgreSQL (padrão: o do compose)                                                                         |
| `DATABASE_POOL_MAX` (20)                                                                                                                                    | conexões por instância                                                                                    |
| `DATABASE_LOCK_TIMEOUT_MS` (5000)                                                                                                                           | espera máxima pelo lock de uma wallet; além disso, 503 / retry                                            |
| `AWS_REGION` · `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` · `SQS_ENDPOINT`                                                                               | cliente SQS (credenciais fictícias para o LocalStack)                                                     |
| `SQS_TRANSACTIONS_QUEUE_URL` · `SQS_TRANSACTIONS_DLQ_URL` · `SQS_EVENTS_QUEUE_URL`                                                                          | filas                                                                                                     |
| `SQS_MAX_RECEIVE_COUNT` (5) · `SQS_VISIBILITY_TIMEOUT_SECONDS` (60) · `SQS_WAIT_TIME_SECONDS` (20)                                                          | tentativas antes da DLQ (fallback: vale o maxReceiveCount da redrive da fila), visibilidade, long polling |
| `SQS_RETRY_BASE_SECONDS` (5) · `SQS_RETRY_MAX_SECONDS` (300)                                                                                                | backoff de retry de mensagem                                                                              |
| `SQS_CONSUMER_NAME`                                                                                                                                         | nome do consumidor na inbox                                                                               |
| `OUTBOX_POLL_INTERVAL_MS` (500) · `OUTBOX_BATCH_SIZE` (50) · `OUTBOX_RETRY_MAX_SECONDS` (300) · `OUTBOX_LAG_ALERT_ATTEMPTS` (10)                            | worker da outbox                                                                                          |
| `OUTBOX_METRICS_INTERVAL_MS` (5000)                                                                                                                         | amostragem de `outbox_pending_total` / `outbox_lag_seconds`                                               |
| `PENDING_REFERENCE_TTL_SECONDS` (3600) · `…_BACKOFF_BASE_SECONDS` (2) · `…_BACKOFF_MAX_SECONDS` (300) · `…_MAX_ATTEMPTS` (20) · `…_POLL_INTERVAL_MS` (1000) | referências fora de ordem                                                                                 |
| `WORKERS_ENABLED` (true)                                                                                                                                    | liga o consumidor SQS e os workers nesta instância                                                        |
| `FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK` (false)                                                                                                               | **só para testes**: mata o processo entre o commit e o ack                                                |

---

## Estrutura do projeto

```
src/
  domain/          regras de negócio puras: Money, Wallet, ledger, WagerTransaction, eventos, inbox/outbox
  application/     use cases e portas (UnitOfWork, repositórios, publisher, identidade do provedor)
  infrastructure/  MikroORM (schemas, mappers, repositórios), SQS (publisher, consumidor), workers, config
  interfaces/      HTTP (controllers, filtro de exceção, AuthGuard, Swagger) e contrato da mensagem SQS
  shared/          logger JSON, métricas Prometheus, tokens de injeção
  container.ts     monta o grafo de objetos (composition root)
  main.ts          inicialização
migrations/        migration versionada e reversível (schema de docs/001_initial_schema.sql)
test/              unit, integration, concurrency, load e utilitários (support)
docker/            criação das filas no LocalStack
docs/              contrato OpenAPI, collection do Postman, auditoria e relatórios
```

---

## Documentação complementar

| Documento                                                                | Conteúdo                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                                       | fluxo ponta a ponta, máquina de estados, dinheiro e ORM, locking, idempotência, outbox/inbox, taxonomia de falhas, decisões (D1–D8, E1–E14), trade-offs e limitações |
| [docs/DECISOES_E_FUNCIONALIDADES.md](docs/DECISOES_E_FUNCIONALIDADES.md) | resumo das funcionalidades e das principais decisões                                                                                                                 |
| [docs/AUDITORIA.md](docs/AUDITORIA.md)                                   | falhas eliminatórias do desafio, cada uma com evidência real                                                                                                         |
| [docs/CONFORMIDADE.md](docs/CONFORMIDADE.md)                             | verificação seção a seção contra o enunciado                                                                                                                         |
| [docs/SEGURANCA.md](docs/SEGURANCA.md)                                   | suíte de abuso: cada tentativa de burlar o sistema, a defesa e o resultado                                                                                           |
| [docs/LOAD_TEST.md](docs/LOAD_TEST.md)                                   | resultado do teste de carga                                                                                                                                          |

---

## Solução de problemas

| Sintoma                                                            | Causa provável e solução                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `Cannot connect to the Docker daemon`                              | O Docker não está rodando: abra o Docker Desktop e tente de novo.                                                              |
| `port is already allocated` (3000, 5432 ou 4566)                   | Outro processo usa a porta: pare-o ou mude o mapeamento no `docker-compose.yml`.                                               |
| `/health/ready` responde 503                                       | O PostgreSQL ou o LocalStack ainda está subindo ou caiu: veja `docker compose ps` e `docker compose logs postgres localstack`. |
| Testes de integração falham ao conectar                            | A infraestrutura não está no ar: rode `bun run test:infra`.                                                                    |
| O teste de contrato diz que `docs/openapi.json` está desatualizado | O spec mudou no código: rode `bun run openapi:export`.                                                                         |
| Quero recomeçar com o banco vazio                                  | `docker compose down -v && docker compose up --build`                                                                          |
