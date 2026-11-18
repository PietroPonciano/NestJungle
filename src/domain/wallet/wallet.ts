/**
 * Wallet — aggregate root.
 *
 * Invariantes encapsuladas:
 *  - Saldo nunca negativo: `debit` recusa (InsufficientBalanceError) antes de
 *    mudar estado. O CHECK balance >= 0 do banco é a rede de segurança.
 *  - Toda alteração de saldo produz exatamente um WalletLedgerEntry, e todo
 *    lançamento corresponde a uma alteração: só `debit`, `credit` e `open`
 *    mudam o saldo, e os três devolvem o lançamento correspondente.
 *  - Moeda da operação == moeda da wallet (CurrencyMismatchError).
 *  - `version` começa em 1 após a criação e incrementa SOMENTE quando o saldo
 *    muda. Na abertura com saldo inicial, o crédito de OPENING faz parte da
 *    criação, por isso a wallet nasce com version 1 (contrato do enunciado §9).
 *  - Unicidade de playerId + currency e ausência de lost update NÃO são
 *    garantidas aqui: dependem do UNIQUE do banco e do lock pessimista por
 *    wallet (Restrições #6, #7 e #9).
 */
import { Money } from '../money/money';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvariantViolationError,
} from '../shared/domain-error';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Ids da transação OPENING e do lançamento, usados só se initialBalance > 0. */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Lançamento CREDIT de abertura; ausente quando o saldo inicial é zero (D3). */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError('Saldo inicial não pode ser negativo');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
    // D3: saldo inicial zero não gera OPENING nem lançamento.
    const openingEntry = props.initialBalance.isZero()
      ? undefined
      : WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: props.initialBalance,
          createdAt: props.at,
        });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Consulta sem efeito colateral; as regras usam para escolher o failureCode. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Crédito que manteria o saldo dentro do limite de NUMERIC(18,2). */
  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    return this._balance.canAdd(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientBalanceError(this.id);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  // Ponto único de mutação do saldo: o lançamento é criado ANTES de alterar o
  // estado, então se a aritmética não fechar nada é mutado.
  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: props.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
