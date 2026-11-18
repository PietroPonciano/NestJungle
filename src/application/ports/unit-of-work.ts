/**
 * UnitOfWork — uma transação SQL com todos os repositórios ligados a ela.
 *
 * Invariantes:
 *  - Tudo que acontece dentro de `run` é atômico: inbox, transação, wallet,
 *    ledger e outbox são confirmados juntos ou nada é (enunciado §11).
 *  - Nenhuma chamada de rede (SQS, HTTP) deve ocorrer dentro de `run` enquanto
 *    o lock de uma wallet está segurado (guia §6.1: transações curtas).
 *  - Erros transitórios do banco (deadlock, lock timeout, conexão) saem como
 *    TransientInfrastructureError. Nada é persistido nesse caso.
 */
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './repositories';

export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}
