/**
 * Reprocessamento de transações em PENDING_REFERENCE (enunciado §7.1; guia §4.6).
 *
 * Dois gatilhos, mesma lógica (`reprocess`):
 *  1. Imediato: quando uma transação fica terminal, os dependentes que esperavam
 *     por ela (providerId, externalTransactionId) são reprocessados logo após o
 *     commit. Em cadeia: ROLLBACK de REFUND que esperava REFUND que esperava BET.
 *  2. Agendado (worker): varre as vencidas com backoff exponencial. É a rede de
 *     segurança se o gatilho imediato se perder (crash, outra instância).
 *
 * Concorrência (Restrições #6/#8):
 *  - O claim das vencidas usa FOR UPDATE SKIP LOCKED + lease (empurra
 *    next_attempt_at). Instâncias diferentes pegam linhas diferentes.
 *  - O reprocessamento trava a WALLET primeiro (mesma ordem do fluxo principal,
 *    sem deadlock) e relê a transação sob o lock. Se outra instância já a
 *    resolveu, não há nada a fazer (idempotente).
 *  - Esgotado o limite/TTL: REJECTED REFERENCE_NOT_FOUND + evento
 *    WagerTransactionRejected, na mesma transação.
 */
import type { PendingReferencePolicy } from '../../domain/wager-transaction/pending-reference-policy';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import {
  TERMINAL_STATUSES,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction-kind';
import { settle } from '../../domain/wager-transaction/wager-settlement';
import type { Clock, IdGenerator } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';
import { enqueueOutcomeEvents, persistBalanceEffect } from './settlement-persistence';
import type { WagerOutcomeListener } from './submit-wager-transaction';
import { type WagerResult, resultOf } from './wager-result';

export interface PendingReferenceLogger {
  error(msg: string, fields: Record<string, string | undefined>): void;
}

export class PendingReferenceProcessor implements WagerOutcomeListener {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: PendingReferencePolicy,
    private readonly logger: PendingReferenceLogger,
    private readonly metrics?: WagerOutcomeListener,
  ) {}

  /** Worker: reivindica um lote vencido e reprocessa. Devolve quantas pegou. */
  async runDue(limit: number): Promise<number> {
    const due = await this.uow.run((s) =>
      s.transactions.findDuePendingReferences(this.clock.now(), limit),
    );
    for (const ref of due) {
      await this.reprocessSafely(ref.transactionId, ref.walletId);
    }
    return due.length;
  }

  /** Reprocessa os dependentes de uma transação que acabou de ficar terminal. */
  async onReferenceSettled(providerId: string, externalTransactionId: string): Promise<void> {
    const waiting = await this.uow.run((s) =>
      s.transactions.findWaitingFor(providerId, externalTransactionId),
    );
    for (const ref of waiting) {
      await this.reprocessSafely(ref.transactionId, ref.walletId);
    }
  }

  // WagerOutcomeListener (ligado ao use case de submissão): gatilho imediato.
  onCommitted(tx: WagerTransaction, result: WagerResult): void {
    if (!isTerminal(result.status)) return;
    // Depois do commit e fora do caminho da resposta: erros só são logados (o
    // worker agendado cobre).
    void this.onReferenceSettled(tx.providerId, tx.externalTransactionId).catch(
      (error: unknown) => {
        this.logger.error('falha no reprocessamento imediato de dependentes', {
          transactionId: tx.id,
          error: String(error),
        });
      },
    );
  }

  onDuplicate(): void {
    // Replays não mudam estado: nada a reprocessar.
  }

  async reprocess(transactionId: string, walletId: string): Promise<WagerResult | undefined> {
    const outcome = await this.uow.run(async (scope) => {
      // Restrição #7 + ordem fixa: wallet primeiro, depois a referência.
      const wallet = await scope.wallets.lockById(walletId);
      if (wallet === undefined) return undefined;
      const tx = await scope.transactions.findById(transactionId);
      // Já resolvida por outra instância/gatilho: idempotente.
      if (tx?.status !== WagerTransactionStatus.PendingReference) return undefined;

      const reference =
        tx.referenceExternalTransactionId === undefined
          ? undefined
          : await scope.transactions.lockByExternalId(
              tx.providerId,
              tx.referenceExternalTransactionId,
            );
      const referenceAlreadyReversed =
        reference !== undefined && (await scope.transactions.hasProcessedReversal(reference.id));
      const at = this.clock.now();
      const { ledgerEntry } = settle({
        wallet,
        transaction: tx,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        policy: this.policy,
        at,
      });
      await scope.transactions.save(tx);
      await persistBalanceEffect(scope, wallet, ledgerEntry);
      await enqueueOutcomeEvents(
        scope,
        this.ids,
        { correlationId: tx.id, causationId: 'pending-reference-worker' },
        at,
        wallet,
        tx,
        ledgerEntry,
        false,
      );
      return { tx, result: resultOf(tx, wallet.balance, false) };
    });

    if (outcome === undefined) return undefined;
    if (isTerminal(outcome.result.status)) {
      this.metrics?.onCommitted(outcome.tx, outcome.result);
      // Cadeia: quem esperava por ESTA transação também pode prosseguir.
      await this.onReferenceSettled(outcome.tx.providerId, outcome.tx.externalTransactionId);
    }
    return outcome.result;
  }

  private async reprocessSafely(transactionId: string, walletId: string): Promise<void> {
    try {
      await this.reprocess(transactionId, walletId);
    } catch (error: unknown) {
      // Transitório (lock, banco): o lease expira e a linha volta ao worker.
      this.logger.error('falha ao reprocessar PENDING_REFERENCE', {
        transactionId,
        error: String(error),
      });
    }
  }
}

function isTerminal(status: WagerTransactionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Encaminha os resultados a vários ouvintes (métricas + gatilho de dependentes). */
export class CompositeOutcomeListener implements WagerOutcomeListener {
  private readonly listeners: WagerOutcomeListener[] = [];

  add(listener: WagerOutcomeListener): this {
    this.listeners.push(listener);
    return this;
  }

  onCommitted(tx: WagerTransaction, result: WagerResult): void {
    for (const l of this.listeners) l.onCommitted(tx, result);
  }

  onDuplicate(): void {
    for (const l of this.listeners) l.onDuplicate();
  }
}
