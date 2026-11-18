# Distributed Wagering Processor — decisões e funcionalidades

Resumo para leitura rápida (ou para apresentação) do que o sistema faz e de por que foi construído assim. O detalhe técnico de cada ponto está no [ARCHITECTURE.md](../ARCHITECTURE.md); as provas, em [AUDITORIA.md](AUDITORIA.md), [CONFORMIDADE.md](CONFORMIDADE.md) e [LOAD_TEST.md](LOAD_TEST.md).

## O problema

Provedores de jogos enviam operações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com entrega **at-least-once**. A mesma operação pode chegar várias vezes, fora de ordem, ao mesmo tempo em várias instâncias, e o processo pode morrer antes ou depois do commit. Mesmo assim, o sistema **não pode** duplicar crédito ou débito, perder um evento confirmado nem deixar um saldo negativo, e o saldo da wallet precisa sempre bater com o ledger.

**Stack:** Bun 1.x · TypeScript estrito · NestJS · PostgreSQL · MikroORM 7 · AWS SQS (LocalStack) · Docker Compose.

---

## Principais funcionalidades

### Wallets e ledger

- **Criação de wallet** (`POST /wallets`): uma por jogador e moeda. O saldo inicial gera uma transação interna `OPENING` e um lançamento de crédito, tudo na mesma transação SQL.
- **Ledger append-only:** todo movimento de saldo gera exatamente um lançamento com saldo antes e depois. O banco impede alterar ou apagar lançamentos, inclusive por `TRUNCATE`.
- **Consulta paginada do ledger** (`GET /wallets/:id/ledger`), com cursor opaco e estável.
- **Reconciliação** (`POST /wallets/:id/reconciliation`): compara o saldo armazenado com o saldo reconstruído pelo ledger. Divergência é logada, contada em métrica e sinalizada na resposta, e nunca corrigida em silêncio.

### Processamento de transações

- **Uma única regra de negócio para duas entradas:** HTTP (`POST /wagering/transactions`) e fila SQS (`wager-transactions.fifo`) chamam o mesmo use case.
- **Regras por operação:**
  - BET debita, ou é rejeitada por saldo insuficiente;
  - WIN credita;
  - LOSS registra o resultado sem mexer no saldo;
  - REFUND reverte uma BET;
  - ROLLBACK reverte uma BET, um WIN ou um REFUND.
- **Validação de referência:** a transação referenciada precisa ser do mesmo provedor, jogador, wallet, moeda e rodada, do tipo certo e com o mesmo valor. Cada referência só pode ser revertida uma vez.
- **Referências fora de ordem:** um ROLLBACK que chega antes da BET fica em `PENDING_REFERENCE` (HTTP 202). Ele é resolvido logo que a BET chega, ou por um worker com backoff exponencial. Esgotado o prazo (1 h ou 20 tentativas), é rejeitado com `REFERENCE_NOT_FOUND`.
- **Códigos de falha estáveis** (`INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `BALANCE_LIMIT_EXCEEDED` e outros): cada um diz ao provedor se ele deve reenviar, corrigir o payload ou desistir.

### Idempotência

- **Header `Idempotency-Key` obrigatório.** Repetir a mesma requisição devolve o **resultado original**, inclusive o saldo da época, com `idempotentReplay: true`.
- **Mesma chave com outro conteúdo é conflito (409)**, não replay. A comparação usa um hash SHA-256 do JSON canônico dos campos de negócio.
- **Na fila:** uma inbox persistente absorve mensagens repetidas. A mesma operação chegando com outro `messageId` também é detectada.

### Mensageria confiável

- **Transactional Outbox:** os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) são gravados na mesma transação do efeito e publicados depois em `wager-events.fifo` por um worker.
- **Consumidor SQS:**
  - ack só depois do commit;
  - retry com backoff para erros transitórios;
  - DLQ para mensagens inválidas ou de wallet inexistente;
  - limite de 5 tentativas;
  - no SIGTERM, conclui a mensagem em andamento e devolve as não iniciadas.

### API e operação

- **Status HTTP distintos e consistentes:**

  | Situação | Status |
  |---|---|
  | Processada (primeira vez) | 201 |
  | Replay | 200 |
  | Pendente de referência | 202 |
  | Rejeição de negócio | 422 |
  | Payload inválido | 400 |
  | Conflito | 409 |
  | Não encontrado | 404 |
  | Falha permanente | 500 |
  | Falha transitória | 503 + `Retry-After` |

  O provedor decide o que fazer pelo código, sem interpretar mensagem de erro.
- **Observabilidade:**
  - logs JSON correlacionados da requisição até o evento publicado, sem valores financeiros;
  - métricas Prometheus (`/metrics`): transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência;
  - health checks `/health/live` e `/health/ready`.
- **Subida com um comando** (`docker compose up`): banco, filas, migrations e aplicação.
- **Swagger UI** em `/docs`, com o contrato OpenAPI 3.1 (`/docs/openapi.json`, exportado em [openapi.json](openapi.json)). Um teste de contrato garante que o spec bate com as rotas e respostas reais.
- **Collection do Postman** pronta, com 33 requisições ([postman/](postman/)).

---

## Principais decisões

### 1. Dinheiro nunca é `number`

`Money` é um value object imutável sobre `decimal.js`, com escala fixa de 2 casas. No banco ficam `NUMERIC(18,2)` e a moeda em coluna separada; o valor sai do driver como string e volta a ser `Money` sem passar por float. Nos contratos, o valor é sempre `{ "amount": "25.00", "currency": "BRL" }`.

**Por quê:** float não representa centavos com exatidão (0,1 + 0,2 ≠ 0,3). Um teste de arquitetura falha se aparecer conversão de dinheiro para `number`.

### 2. Lock pessimista por wallet

Toda operação que mexe em saldo começa com `SELECT … FOR UPDATE` na linha da wallet e só depois lê o saldo.

**Por quê:** é simples e determinístico, e operações da mesma wallet ficam em fila. O lock é só daquela linha, então wallets diferentes andam em paralelo.

**Alternativas descartadas:**
- **Lock otimista (`version`):** retrabalho e starvation numa wallet muito disputada.
- **Update condicionado:** não protege junto o ledger, a transação e a outbox. Ficou só como rede de segurança, via `CHECK (balance >= 0)`.

**Trade-off:** a vazão de uma única wallet fica limitada pela duração da transação, cerca de 1 ms no teste de carga. Um `lock_timeout` de 5 s transforma esperas longas em 503, em vez de uma fila infinita.

### 3. O banco é a última linha de defesa

Unicidade, imutabilidade e não-negatividade estão no **schema**, não só no código:
- UNIQUE por provedor + id externo e por provedor + chave de idempotência;
- CHECK de saldo ≥ 0;
- CHECK da aritmética de cada lançamento;
- índice único que permite uma só reversão por referência;
- triggers que bloqueiam UPDATE, DELETE e TRUNCATE no ledger.

**Por quê:** com várias instâncias e corridas reais, o código pode errar; o PostgreSQL não deixa o erro virar dado. Cada constraint tem um teste que tenta violá-la direto no banco.

### 4. Idempotência sob corrida, sem abortar a transação

Primeiro trava a wallet, depois consulta a chave. A gravação usa `INSERT … ON CONFLICT DO NOTHING`; se voltar 0 linhas, relê e compara o hash.

**Por quê:** no PostgreSQL, um erro de UNIQUE aborta a transação inteira. O `DO NOTHING` espera a transação concorrente terminar e devolve "já existe" sem quebrar nada. Isso cobre até a mesma chave chegando com wallets diferentes, que travam linhas diferentes.

### 5. Transactional Outbox + inbox

O efeito financeiro, o lançamento, a inbox (quando a entrada vem da fila) e o evento são gravados juntos ou nada é gravado. Só o worker publica, e só depois do commit.

**Concorrência entre publishers:** cada um pega um lote com `FOR UPDATE SKIP LOCKED`, sem disputar linhas.

**Se o processo morrer entre publicar e marcar como publicado:** outro publica de novo com o mesmo `eventId`. O FIFO deduplica, e o consumidor também.

**Por quê:** publicar antes do commit (ou fora da transação) pode anunciar um efeito que nunca aconteceu, ou perder um que aconteceu.

### 6. SQS FIFO é otimização, não garantia

O FIFO dá ordem por wallet (`MessageGroupId = walletId`) e deduplicação de curto prazo, mas a correção não depende disso. A garantia final é a inbox persistente mais os UNIQUEs do banco.

**Prova:** a mesma operação enviada com ids de deduplicação e messageIds diferentes produz um único efeito.

### 7. Taxonomia de falhas com tratamento claro

| Tipo de falha | O que acontece |
|---|---|
| Negócio | Vira `REJECTED` com `failureCode`, é gravada, recebe ack e devolve 422. |
| Transitória (deadlock, timeout, banco ou SQS fora) | **Nunca vira status gravado.** Volta para a fila com backoff, ou devolve 503. |
| Permanente sem dados para gravar (payload inválido, wallet inexistente) | Devolve 400/404 ou vai para a DLQ, sem linha no banco. |
| Permanente inesperada | Vira `FAILED`, gravado numa transação separada (fica auditável), e devolve 500. |

### 8. Domínio puro e DDD

O domínio (Money, Wallet, ledger, máquina de estados da transação, regras, eventos) não conhece NestJS, ORM nem AWS. As entidades têm construtor privado e factories (`create`, `open`, `rehydrate`), e as transições são explícitas: um estado terminal não muda mais. O NestJS fica só na borda, e o MikroORM mapeia o domínio por `EntitySchema` e mappers, sem decorators.

**Por quê:** as regras financeiras são testáveis sem infraestrutura (132 testes unitários em ~20 ms) e as dependências ficam visíveis.

### 9. Interpretações documentadas

Onde o enunciado deixa margem, a decisão está registrada com o motivo (D1–D8 e E1–E14 no ARCHITECTURE.md). As mais relevantes:

- **Uma só reversão por referência (D1):** REFUND ou ROLLBACK, não um de cada. O enunciado fala em "mesmo tipo", mas permitir os dois creditaria duas vezes.
- **Referência rejeitada não fica esperando (D2):** rejeita na hora com `REFERENCE_NOT_PROCESSED`.
- **LOSS aceita valor zero (D4);** as demais operações exigem valor positivo.
- **Replay devolve o saldo observado na época (D6),** guardado na própria transação, porque LOSS e rejeições não têm lançamento.
- **Eventos numa fila separada (D8),** para o consumidor não ler os próprios eventos.

### 10. Autenticação como ponto de extensão

Não foi implementada, como o enunciado permite. O desenho está documentado: IdP externo (Keycloak ou Zitadel), JWT via OIDC por provedor e nenhuma tabela de usuários. No código já existem um `AuthGuard` no-op e a `ProviderIdentityPort`, injetada no use case.

### 11. OpenAPI escrito à mão, com teste de contrato

O spec OpenAPI 3.1 é escrito à mão e reaproveita os enums do domínio, em vez de ser gerado pelos decorators do `@nestjs/swagger`.

**Por quê:** a validação de entrada não usa DTOs com metadata (o Bun não emite essa informação), e o comportamento que mais importa ao provedor (replay, 202, 503 com `Retry-After`, `failureCode`) teria que ser escrito à mão de qualquer forma.

**Sem drift:** um teste de contrato sobe a app real e falha se uma rota existir sem documentação (ou o contrário), se uma resposta real não bater com o schema do seu status ou se o arquivo exportado estiver desatualizado.

### 12. Testes com infraestrutura real

- **Sem mocks de infraestrutura:** nenhum mock substitui PostgreSQL ou SQS; testes de integração e concorrência usam os containers.
- **Processos reais:** os cenários de concorrência sobem a aplicação como processos (`Bun.spawn`) e os matam (`kill -9` e SIGTERM). Cobrem:
  - 3 instâncias simultâneas;
  - worker morto entre o commit e o ack;
  - reinício no meio do processamento.
- **Invariante final em todos os testes com banco**, conferida direto no PostgreSQL: saldo = ledger, sem lançamento duplicado, sem saldo negativo.
- **Suíte de abuso** ([SEGURANCA.md](SEGURANCA.md)): 27 tentativas de burlar o sistema (corridas, reversão dupla simultânea, mass assignment, SQL injection, referências alheias), cada uma com a defesa que a barra.
- **Números:** 291 testes, estáveis em execuções repetidas.

---

## Trade-offs e limitações conhecidas

| Ponto | Situação | Possível evolução |
|---|---|---|
| Wallet muito disputada | Operações da mesma wallet são serializadas (~1 ms por transação no teste de carga) | Aceitável para o domínio; wallets diferentes escalam em paralelo |
| Vazão da outbox | O atraso de publicação cresce com a carga (chegou a ~37 s no estágio mais alto, com uma instância), **sem perda** | `SendMessageBatch`, publicação paralela por wallet, mais instâncias |
| Ordem dos eventos por wallet | Aproximada (um evento em backoff pode ser ultrapassado) | Consumidor ordena por `walletVersion` e deduplica por `eventId` |
| Encerramento | Pode levar até 20 s (espera longa da fila) | Reduzir `SQS_WAIT_TIME_SECONDS` ao custo de mais chamadas |
| Autenticação | Não implementada (permitido) | IdP externo, conforme o desenho documentado |

## Números de referência

- **Testes:** 291 (136 unitários sem infraestrutura, 119 de integração com PostgreSQL/LocalStack reais, 9 cenários com processos reais, 27 de abuso/segurança).
- **Carga progressiva com personas** (1 instância, mesma máquina, de 6 a 96 usuários):
  - satura por volta de 24 usuários, com pico de ~1.660 req/s; a partir daí, mais usuários só aumentam a latência (fila);
  - todos disputando a mesma wallet: ~950 req/s, p99 de 74 ms;
  - 0 erros em ~60 mil requisições e invariantes preservadas, inclusive com os jogadores agressivos zerando o próprio saldo.
- **Falhas eliminatórias do enunciado:** nenhuma presente, com a evidência de cada item em [AUDITORIA.md](AUDITORIA.md).
