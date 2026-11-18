# Suíte de abuso e segurança

Cada item abaixo é uma **tentativa de burlar o sistema** (como faria um provedor mal-intencionado ou um cliente com bug), a defesa que a barra e o resultado comprovado por teste automatizado contra a aplicação real (PostgreSQL e LocalStack reais).

- **Código:** [test/security/abuse.test.ts](../test/security/abuse.test.ts).
- **Execução:** `bun run test:security`, ou junto com a suíte completa em `bun test`.
- **Evidência:** [evidence/08-seguranca.txt](evidence/08-seguranca.txt), com 27/27 testes passando.

Ao final de cada teste, a invariante global é conferida direto no banco: saldo == ledger, nenhum lançamento duplicado, nenhum saldo negativo.

## A. Dinheiro e saldo

| Tentativa | Defesa | Resultado |
|---|---|---|
| Rajada de 100 apostas paralelas de 1.00 numa wallet de 50.00 | Lock pessimista por wallet (`SELECT … FOR UPDATE`) + `CHECK (balance >= 0)` | exatamente 50 aceitas, 50 × 422 `INSUFFICIENT_FUNDS`, saldo 0.00 |
| REFUND + ROLLBACK + segundo REFUND da mesma aposta **ao mesmo tempo** (10 rodadas) | Checagem D1 sob o lock da wallet + índice único `uq_tx_single_reversal` | 1 reversão por aposta, as outras 2 com `ALREADY_REVERSED`; saldo final igual ao inicial |
| Reverter um valor maior que o apostado | Regra 5 (valor da reversão = valor da referência) | 422 `AMOUNT_MISMATCH` |
| Desfazer a própria reversão (ROLLBACK de ROLLBACK) ou reembolsar um prêmio (REFUND de WIN) | Regra 3 (tipos referenciáveis) | 422 `REFERENCE_INVALID_KIND` |
| Ganhar, gastar o prêmio e pedir ROLLBACK do prêmio | Regra 9 | 422 `REVERSAL_WOULD_OVERDRAW`, saldo nunca negativo |
| Crédito que estouraria o limite de `NUMERIC(18,2)` | `Wallet.canCredit` antes de aplicar | 422 `BALANCE_LIMIT_EXCEEDED`, saldo intacto |
| Valores malformados: negativo, `1e9`, 3 casas, `NaN`, `Infinity`, vírgula, espaços, zeros à esquerda, `+1.00`, hexadecimal, 17 dígitos, `number`, `null`, `true`, array, objeto; BET/WIN de 0.00 | `Money.fromInput` (string decimal estrita) + regras de criação da transação | 400 em todos, nenhuma linha gravada |

## B. Identidade e referências

| Tentativa | Defesa | Resultado |
|---|---|---|
| Apostar na wallet de outro jogador | `playerId` do payload deve ser o dono da wallet | 422 `PLAYER_MISMATCH`; a vítima não é debitada |
| Usar a aposta de outro jogador como referência de REFUND na própria wallet | Regra 2 (mesmo provider, player, wallet e rodada) | 422 `REFERENCE_MISMATCH` |
| Provedor B tenta reverter a aposta do provedor A (mesmo `externalTransactionId`) | Referência resolvida por `(providerId, externalTransactionId)` | para o provedor B a referência não existe: 202 `PENDING_REFERENCE` (e depois `REFERENCE_NOT_FOUND`); nunca credita |
| Moeda trocada (USD numa wallet BRL) | Moeda da operação = moeda da wallet | 422 `CURRENCY_MISMATCH` |
| Submeter `OPENING` (crédito interno de abertura), inclusive em minúsculas | Só `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` são aceitos nos contratos | 400 |
| Forjar `status`, `transactionId`, `balance`, `observedBalance`, `failureCode` e `processedAt` no corpo (mass assignment) | Parser lê só os campos do contrato | campos ignorados; id e saldo reais |
| Provedor sem permissão (quando a autenticação existir) | `ProviderIdentityPort.authorize` roda antes de qualquer escrita | `ProviderNotAuthorizedError` (HTTP 403); nada gravado |

## C. Idempotência

| Tentativa | Defesa | Resultado |
|---|---|---|
| Reusar a `Idempotency-Key` de uma aposta trocando o valor | `payloadHash` (SHA-256 do JSON canônico) | 409; o replay da original continua devolvendo o resultado original |
| Mesmo `externalTransactionId` com outra chave, para aplicar duas vezes | UNIQUE `(provider_id, external_transaction_id)` | 409 |
| Provedor B usa a mesma chave e o mesmo id do provedor A para "ler" o resultado dele | Chave única **por provedor** (D5) | é outra operação, com resultado próprio; não há vazamento |

## D. Entrada e protocolo

| Tentativa | Defesa | Resultado |
|---|---|---|
| SQL injection nos campos de texto (`'; DROP TABLE wallets; --`, `' OR '1'='1`) | Queries parametrizadas (MikroORM / `pg`) | gravado literalmente, tabelas intactas; consulta com injeção na URL dá 404 |
| Ids maliciosos na rota (`' OR 1=1 --`, `../etc/passwd`, UUID inválido) | Validação de UUID antes de chegar ao banco | 400 |
| Corpo gigante (> 100 KB) | Limite do body parser | 413 `PAYLOAD_TOO_LARGE` |
| JSON malformado, array, string ou `null` no lugar do objeto | Parser de contrato | 400 |
| `X-Correlation-Id` malicioso (script, 5.000 caracteres, JSON) para poluir os logs | Formato restrito `^[\w.:-]{1,128}$` | valor recusado e substituído por UUID gerado |
| Cursor e `limit` forjados para ler além da página ou de outra wallet | Cursor validado; a consulta sempre filtra pela wallet da rota; `limit` de 1 a 200 | 400; nenhum lançamento de outra wallet aparece |
| Path traversal nos arquivos do Swagger | Lista fechada de arquivos | 404 |
| Mensagem SQS com `kind: OPENING`, sem `idempotencyKey`, com valor `number` ou de outro `type` | Parser da mensagem | payload inválido: vai à DLQ, sem linha no banco |

## Risco conhecido (documentado, não é falha)

**Um WIN sem referência credita direto.** O enunciado permite ("pode referenciar a BET"), então um provedor mal-intencionado pode creditar sem aposta prévia. A defesa não está na regra de negócio, e sim em **saber quem é o provedor**:
- autenticação via IdP externo (Keycloak ou Zitadel);
- `ProviderIdentityPort` garantindo que cada cliente só opera em nome do próprio provedor.

O ponto de extensão já existe e o teste acima prova que ele barra o provedor antes de qualquer escrita. Hoje a implementação é permissiva, porque a autenticação não foi implementada, como o enunciado permite.

## Problemas encontrados por esta suíte (já corrigidos)

1. **Crédito além do limite virava 500.** Um WIN que levaria o saldo além de `NUMERIC(18,2)` era gravado como `FAILED / INTERNAL_PERMANENT_ERROR` (HTTP 500, "abra um chamado"). O saldo sempre ficou protegido, mas é um limite previsível. Agora vira 422 `BALANCE_LIMIT_EXCEEDED`.
2. **Corpo grande devolvia código genérico.** O 413 vinha com `HTTP_ERROR`; agora traz `PAYLOAD_TOO_LARGE`.
3. **O ponto de extensão de identidade não tinha como recusar.** Não havia um erro próprio, e qualquer exceção ali viraria 500. Agora existe `ProviderNotAuthorizedError`, que vira 403 no HTTP e vai para a DLQ na fila.
