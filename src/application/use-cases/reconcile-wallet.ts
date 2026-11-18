/**
 * Use case: reconciliação (POST /wallets/:walletId/reconciliation).
 *
 * Compara o saldo materializado (wallets.balance) com o saldo reconstruído pela
 * soma com sinal de todos os lançamentos do ledger (fonte de verdade).
 *
 * Invariantes:
 *  - NUNCA corrige nada silenciosamente: divergência é logada, contabilizada em
 *    métrica e sinalizada na resposta (consistent: false).
 *  - Leitura consistente: travamos a wallet (FOR UPDATE) durante as duas
 *    leituras. Em READ COMMITTED, sem o lock, um commit entre "ler o saldo" e
 *    "somar o ledger" produziria uma falsa divergência. O lock é curto e só
 *    desta wallet (Restrição #6).
 */
import type { MoneyProps } from '../../domain/money/money';
import { WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export interface ReconciliationObserver {
  onDivergence(report: ReconciliationReport): void;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly observer: ReconciliationObserver,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(async (scope) => {
      const wallet = await scope.wallets.lockById(walletId);
      if (wallet === undefined) throw new WalletNotFoundError(walletId);
      const { balance: calculated, entries } = await scope.ledger.reconstruct(
        walletId,
        wallet.currency,
      );
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: entries,
      };
    });
    if (!report.consistent) this.observer.onDivergence(report);
    return report;
  }
}
