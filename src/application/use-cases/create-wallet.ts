/**
 * Use case: criar wallet (POST /wallets).
 *
 * Invariantes:
 *  - Atomicidade (enunciado §9): wallet + OPENING PROCESSED + lançamento
 *    CREDIT + eventos na outbox, na MESMA transação SQL. Saldo inicial zero:
 *    só a wallet, sem OPENING nem eventos (D3).
 *  - Duplicata de playerId + currency: o UNIQUE uq_wallets_player_currency
 *    recusa, mesmo sob corrida entre instâncias, e vira WalletAlreadyExistsError
 *    (409). O rollback desfaz tudo e não sobra OPENING órfã.
 */
import type { Money, MoneyProps } from '../../domain/money/money';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../../domain/shared/events/wager-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { InvariantViolationError } from '../../domain/shared/domain-error';
import type { Clock, IdGenerator } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';
import { type OperationContext, eventContext } from './event-context';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand, ctx: OperationContext): Promise<WalletView> {
    const at = this.clock.now();
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.next(),
      at,
    });

    await this.uow.run(async (scope) => {
      await scope.wallets.insert(wallet);
      if (openingEntry === undefined) return;

      const opening = WagerTransaction.opening({
        id: openingTransactionId,
        walletId,
        playerId: command.playerId,
        money: command.initialBalance,
        at,
      });
      opening.markProcessed({
        referenceTransactionId: undefined,
        observedBalance: wallet.balance,
        at,
      });
      // A wallet é nova e a chave da OPENING é derivada do walletId, então não
      // há conflito possível. Se houver, é erro de programação.
      if (!(await scope.transactions.insertIfAbsent(opening))) {
        throw new InvariantViolationError(`OPENING duplicada para a wallet ${walletId}`);
      }
      await scope.ledger.append(openingEntry);
      // D3: OPENING emite WagerTransactionProcessed e WalletBalanceChanged.
      await scope.outbox.enqueue(
        OutboxMessage.enqueue(
          WagerTransactionProcessed.from(opening, eventContext(this.ids, ctx, at)),
        ),
      );
      await scope.outbox.enqueue(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, openingEntry, eventContext(this.ids, ctx, at)),
        ),
      );
    });

    return toWalletView(wallet);
  }
}
