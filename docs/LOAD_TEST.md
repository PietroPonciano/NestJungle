# Teste de carga progressivo com personas

Executado em 2026-11-18T18:00:18.243Z com `bun run test:load`. Sem meta de RPS: o objetivo é mostrar onde o sistema satura e provar que a correção se mantém sob carga crescente e comportamento agressivo.

## Ambiente

- **Máquina:** Apple M4 (10 núcleos lógicos), 16 GiB RAM, Darwin 27.2.0 (arm64).
- **Gerador de carga:** Bun 1.4.4, no mesmo host do alvo (disputa CPU com ele).
- **Alvo:** http://localhost:3000 — **1 instância** da app (docker compose), PostgreSQL 17 e LocalStack 4.9 em containers no mesmo host, com o consumidor SQS e os workers da outbox e de pendências ligados.

## Metodologia

- Cada usuário virtual é um **jogador com a própria wallet** (saldo inicial 1000.00) e roda em laço fechado: só envia a próxima requisição depois da resposta da anterior.
- **Rampa:** 6 → 12 → 24 → 48 → 96 usuários no total, divididos igualmente entre as três personas, 8 s por estágio. Depois, um estágio **hot wallet** com 32 usuários na MESMA wallet (saldo 500.00; BET 1.00 / WIN 0.50; 10% reenvios).
- **Latência:** medida no cliente (ida e volta HTTP).
- **Erro:** falha de rede ou 5xx (inclui 503 transitório). 422 (rejeição de negócio) e 200 (replay) **não** são erro.
- **Conflitos de lock e outbox lag:** vêm do `/metrics` da app (delta por estágio; lag e pendências amostrados a cada 500 ms).

| Persona | Comportamento |
|---|---|
| **agressivo** | BET 75% de 20.00–80.00 · WIN 25% de 10.00–120.00 · rajada de 3 simultâneas na própria wallet · 20% reenvios |
| **moderado** | BET 55% de 2.00–15.00 · WIN 30% de 1.00–20.00 · LOSS 10% · REFUND 5% de uma aposta própria · 10% reenvios |
| **conservador** | BET 50% de 0.50–3.00 · WIN 30% de 0.50–5.00 · LOSS 20% · uma por vez com pausa de 50 ms · 2% reenvios |

## Resultados por estágio (rampa)

| Estágio | Requisições | req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Erro | Rejeitadas (422) | Conflitos de lock | Outbox: máx pendentes / máx lag (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| 6 usuários | 9303 | 1156.4 | 4.7 | 11.0 | 21.4 | 52.7 | 0.0% | 25.2% | 0 | 7660 / 4.1 |
| 12 usuários | 11830 | 1468.7 | 7.5 | 17.0 | 29.7 | 48.0 | 0.0% | 24.6% | 0 | 20361 / 10.0 |
| 24 usuários | 12498 | 1558.1 | 16.9 | 31.0 | 44.2 | 64.6 | 0.0% | 27.0% | 0 | 34506 / 16.4 |
| 48 usuários | 12719 | 1573.9 | 40.1 | 58.4 | 66.2 | 82.5 | 0.0% | 24.3% | 0 | 50134 / 23.2 |
| 96 usuários | 13500 | 1663.2 | 82.9 | 109.2 | 118.4 | 135.1 | 0.0% | 23.0% | 0 | 68180 / 30.9 |
| hot wallet | 7622 | 949.9 | 31.6 | 53.3 | 73.9 | 123.1 | 0.0% | 30.8% | 0 | 75402 / 36.8 |

## Resultados por persona em cada estágio

| Estágio | Persona | Requisições | req/s | p50 (ms) | p95 (ms) | p99 (ms) | Erro | Rejeitadas (422) | Motivos das rejeições | Replays |
|---|---|---|---|---|---|---|---|---|---|---|
| 6 usuários | agressivo | 5370 | 667.5 | 5.8 | 12.2 | 23.3 | 0.0% | 39.0% | INSUFFICIENT_FUNDS: 2092 | 1046 |
| 6 usuários | moderado | 3645 | 453.1 | 3.9 | 7.4 | 14.8 | 0.0% | 6.9% | INSUFFICIENT_FUNDS: 253 | 358 |
| 6 usuários | conservador | 288 | 35.8 | 4.6 | 11.4 | 25.1 | 0.0% | 0.0% | — | 8 |
| 12 usuários | agressivo | 6657 | 826.5 | 9.5 | 18.3 | 32.4 | 0.0% | 38.3% | INSUFFICIENT_FUNDS: 2548 | 1302 |
| 12 usuários | moderado | 4624 | 574.1 | 6.4 | 10.3 | 25.2 | 0.0% | 7.9% | INSUFFICIENT_FUNDS: 364 | 463 |
| 12 usuários | conservador | 549 | 68.2 | 7.5 | 13.1 | 29.0 | 0.0% | 0.0% | — | 16 |
| 24 usuários | agressivo | 7554 | 941.8 | 19.1 | 32.9 | 46.8 | 0.0% | 40.2% | INSUFFICIENT_FUNDS: 3037 | 1491 |
| 24 usuários | moderado | 3988 | 497.2 | 15.1 | 24.9 | 38.7 | 0.0% | 8.5% | INSUFFICIENT_FUNDS: 337 | 373 |
| 24 usuários | conservador | 956 | 119.2 | 15.6 | 29.0 | 39.5 | 0.0% | 0.0% | — | 21 |
| 48 usuários | agressivo | 7989 | 988.6 | 41.8 | 60.3 | 67.9 | 0.0% | 36.9% | INSUFFICIENT_FUNDS: 2945 | 1621 |
| 48 usuários | moderado | 3294 | 407.6 | 37.6 | 54.6 | 61.0 | 0.0% | 4.4% | INSUFFICIENT_FUNDS: 144 | 338 |
| 48 usuários | conservador | 1436 | 177.7 | 38.0 | 54.0 | 60.6 | 0.0% | 0.0% | — | 30 |
| 96 usuários | agressivo | 8457 | 1041.9 | 84.1 | 110.8 | 119.8 | 0.0% | 35.8% | INSUFFICIENT_FUNDS: 3031 | 1716 |
| 96 usuários | moderado | 3109 | 383.0 | 80.5 | 105.9 | 113.7 | 0.0% | 2.6% | INSUFFICIENT_FUNDS: 80 | 299 |
| 96 usuários | conservador | 1934 | 238.3 | 81.7 | 105.5 | 115.1 | 0.0% | 0.0% | — | 34 |

Outbox drenada 66.3 s depois do fim da carga (pendentes restantes: 0).

## Invariantes depois da carga (consultadas direto no PostgreSQL)

| Verificação | Resultado |
|---|---|
| Wallets com saldo ≠ ledger | 0 |
| Lançamentos duplicados por transação | 0 |
| Saldos negativos no histórico (balance_before/after) | 0 |
| Transações duplicadas (mesmo externalTransactionId) | 0 |
| Transações / lançamentos gravados | 57686 / 40849 |
| Saldo final da hot wallet | 0.50 |
| Saldos finais — agressivo (mín / mediana / máx) | 0.78 / 45.36 / 292.16 |
| Saldos finais — moderado (mín / mediana / máx) | 0.59 / 760.43 / 1086.29 |
| Saldos finais — conservador (mín / mediana / máx) | 904.62 / 994.42 / 1009.22 |

**Resultado: invariantes preservadas.**

## Análise

- **Onde satura:** a vazão para de crescer (ou o p99 dispara) a partir de **24 usuários (vazão +6.1% vs. estágio anterior; p99 44.2 ms vs. 21.4 ms no primeiro)**. Daí em diante, mais usuários só aumentam a fila de espera. Pico medido: 1663.2 req/s.
- **Erros:** 0 de 59850 requisições da rampa (0.0%) falharam por erro de rede ou 5xx.
- **Isolamento entre personas (estágio mais alto):** o conservador teve p99 de 115.1 ms e o agressivo, que dispara rajadas na própria wallet, 119.8 ms. Como o lock é **por wallet**, a disputa do agressivo fica na wallet dele: o conservador só sente a carga geral (CPU, pool de conexões), não a fila do agressivo.
- **Comportamento agressivo:** 35.8% das requisições do agressivo no estágio mais alto foram rejeitadas (INSUFFICIENT_FUNDS: 3031). As rajadas simultâneas na mesma wallet ficaram em fila no lock e **nenhum saldo ficou negativo** em momento algum (22 de 32 jogadores agressivos terminaram com menos de 10% do saldo inicial, como esperado de quem aposta alto).
- **Hot wallet:** com todos na mesma wallet, as operações ficam em fila no `SELECT … FOR UPDATE`: 949.9 req/s, p99 de 73.9 ms e 0 conflitos de lock (esperas além do `lock_timeout` de 5 s). É o trade-off documentado do lock pessimista: correção determinística em troca de vazão por wallet.
- **Outbox lag:** chegou a 36.8 s no pior estágio e cresce com a carga, porque uma instância publica um evento por chamada ao SQS. **Nenhum evento se perdeu** (pendentes restantes: 0). Melhorias possíveis: `SendMessageBatch`, paralelismo entre wallets e mais instâncias (o claim com SKIP LOCKED escala horizontalmente).
- **Limitações do experimento:** gerador, app e banco no mesmo host (os números valem para esta máquina, não para produção); uma instância só; LocalStack em vez de SQS real; estágios curtos (sem regime estacionário longo nem efeitos de autovacuum).
