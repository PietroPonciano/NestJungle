/**
 * Persistência do efeito de uma liquidação, compartilhada entre a submissão
 * (HTTP/SQS) e o worker de PENDING_REFERENCE.
 *
 * Invariante (enunciado §11): saldo, lançamento, estado da transação e
 * eventos entram na MESMA transação SQL. Esta função só enfileira escritas na
 * transação corrente (`scope`); quem confirma é a UnitOfWork.
 */
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/shared/events/wager-events';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-kind';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { IdGenerator } from '../ports/system';
import type { TransactionScope } from '../ports/unit-of-work';
import { type OperationContext, eventContext } from './event-context';

export async function persistBalanceEffect(
  scope: TransactionScope,
  wallet: Wallet,
  ledgerEntry: WalletLedgerEntry | undefined,
): Promise<void> {
  // Toda alteração de saldo tem exatamente um lançamento, e vice-versa: os
  // dois são gravados juntos ou nenhum é.
  if (ledgerEntry === undefined) return;
  await scope.wallets.save(wallet);
  await scope.ledger.append(ledgerEntry);
}

/**
 * Restrição #4: os eventos vão para a outbox na mesma transação; quem publica
 * é só o worker, depois do commit.
 * `enteredPendingReference` = a transação ACABOU de entrar em
 * PENDING_REFERENCE (reagendamentos do worker não repetem o evento).
 */
export async function enqueueOutcomeEvents(
  scope: TransactionScope,
  ids: IdGenerator,
  ctx: OperationContext,
  at: Date,
  wallet: Wallet,
  tx: WagerTransaction,
  ledgerEntry: WalletLedgerEntry | undefined,
  enteredPendingReference: boolean,
): Promise<void> {
  const enqueue = (msg: OutboxMessage) => scope.outbox.enqueue(msg);
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      await enqueue(
        OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, eventContext(ids, ctx, at))),
      );
      // WalletBalanceChanged SOMENTE quando o saldo muda (LOSS não emite).
      if (ledgerEntry !== undefined) {
        await enqueue(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, ledgerEntry, eventContext(ids, ctx, at)),
          ),
        );
      }
      return;
    case WagerTransactionStatus.Rejected:
      await enqueue(
        OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventContext(ids, ctx, at))),
      );
      return;
    case WagerTransactionStatus.PendingReference:
      if (enteredPendingReference) {
        await enqueue(
          OutboxMessage.enqueue(
            WagerTransactionPendingReference.from(tx, eventContext(ids, ctx, at)),
          ),
        );
      }
      return;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.Failed:
      return;
  }
}
