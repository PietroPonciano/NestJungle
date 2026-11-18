/**
 * WalletLedgerEntry — lançamento imutável do ledger (fonte de verdade da
 * reconciliação).
 *
 * Invariantes encapsuladas:
 *  - Restrição #5: imutabilidade ESTRUTURAL. Todos os campos são readonly e
 *    não existe nenhum método de transição. O banco reforça com triggers que
 *    bloqueiam UPDATE, DELETE e TRUNCATE.
 *  - Aritmética: balanceBefore ± money === balanceAfter (CREDIT soma, DEBIT
 *    subtrai). Verificada em `create`; espelha o CHECK ck_ledger_balanced.
 *  - money > 0: LOSS e transações REJECTED nunca geram lançamento (CHECK amount > 0).
 *  - balanceBefore e balanceAfter >= 0: saldo nunca negativo, nem no histórico.
 *  - money, balanceBefore e balanceAfter na mesma moeda.
 *  - No máximo um lançamento por wallet por transação: garantido pelo UNIQUE
 *    (wallet_id, transaction_id) no banco e pelo fluxo da Wallet.
 */
import { Money } from '../money/money';
import { InvariantViolationError } from '../shared/domain-error';
import { LedgerDirection } from './ledger-direction';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new InvariantViolationError('Lançamento com moedas divergentes');
    }
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('Lançamento exige valor > 0 (LOSS/REJECTED não lançam)');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvariantViolationError('Lançamento com saldo negativo');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError('Aritmética do lançamento não fecha');
    }
    return entry;
  }

  /** Reconstrução a partir do banco: não revalida (o CHECK do banco já garantiu). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito com sinal sobre o saldo (+ crédito, − débito); usado na reconciliação. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
