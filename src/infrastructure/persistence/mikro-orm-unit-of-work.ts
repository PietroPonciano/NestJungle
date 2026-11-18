/**
 * UnitOfWork sobre MikroORM: `em.fork().transactional()`.
 *
 * - Cada `run` = 1 transação SQL (READ COMMITTED) com um EntityManager novo,
 *   sem identity map compartilhado entre requisições ou instâncias.
 * - `SET LOCAL lock_timeout`: quem espera o lock de uma wallet quente além do
 *   limite recebe 55P03, classificado como transitório (503 / retry). Isso
 *   evita filas de espera ilimitadas no pool.
 * - Erros transitórios saem como TransientInfrastructureError, depois do
 *   rollback. Nada foi gravado (D7).
 */
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../application/errors';
import type { TransactionScope, UnitOfWork } from '../../application/ports/unit-of-work';
import { isLockConflict, isTransientDbError } from './db-errors';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './mikro-orm-repositories';

export interface UnitOfWorkObserver {
  onLockConflict(): void;
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
    private readonly observer?: UnitOfWorkObserver,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // Valor numérico validado na config; SET não aceita parâmetro bind.
        await em.execute(`SET LOCAL lock_timeout = '${String(this.lockTimeoutMs)}ms'`);
        return work({
          wallets: new MikroOrmWalletRepository(em),
          transactions: new MikroOrmWagerTransactionRepository(em),
          ledger: new MikroOrmLedgerRepository(em),
          inbox: new MikroOrmInboxRepository(em),
          outbox: new MikroOrmOutboxRepository(em),
        });
      });
    } catch (error: unknown) {
      if (error instanceof TransientInfrastructureError) throw error;
      if (isTransientDbError(error)) {
        if (isLockConflict(error)) this.observer?.onLockConflict();
        throw new TransientInfrastructureError('Falha transitória no banco de dados', error, 1);
      }
      throw error;
    }
  }
}
