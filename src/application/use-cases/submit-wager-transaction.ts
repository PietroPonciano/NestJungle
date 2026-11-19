/**
 * Use case: submeter transação de aposta. É a ÚNICA entrada para HTTP
 * (POST /wagering/transactions) e para o consumidor SQS (enunciado §10).
 *
 * Fluxo numa única transação SQL (guia §6.2):
 *   1. trava a wallet (FOR UPDATE)                       Restrições #6/#7
 *   2. [SQS] inbox INSERT ... ON CONFLICT DO NOTHING     Restrição #2
 *   3. procura (provider, key) / (provider, externalId) -> replay ou 409
 *   4. resolve e trava a referência (wallet -> referência)
 *   5. liquida em memória (regras puras do domínio)
 *   6. INSERT da transação ON CONFLICT DO NOTHING; com 0 linhas, relê e
 *      compara o hash (corrida com a mesma key em OUTRA wallet, que tem outro lock)
 *   7. wallet + ledger + outbox, no mesmo commit         Restrição #4
 *
 * Taxonomia (§8.1):
 *   negócio     -> REJECTED gravado (resultado, não exceção)
 *   transitório -> TransientInfrastructureError; nada gravado (D7)
 *   payload inválido / wallet inexistente -> 400/404, sem linha (D7)
 *   inesperado  -> FAILED (INTERNAL_PERMANENT_ERROR), gravado em transação
 *                  PRÓPRIA depois do rollback da original
 */
import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { Money } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/wager-transaction/failure-code';
import type { PendingReferencePolicy } from '../../domain/wager-transaction/pending-reference-policy';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import {
  SUBMITTABLE_KINDS,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction-kind';
import { settle } from '../../domain/wager-transaction/wager-settlement';
import {
  ApplicationError,
  ConcurrentInsertConflictError,
  IdempotencyConflictError,
  InboxConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
} from '../errors';
import { AllowAllProviderIdentity, type ProviderIdentityPort } from '../ports/provider-identity';
import type { Clock, IdGenerator } from '../ports/system';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work';
import type { OperationContext } from './event-context';
import { enqueueOutcomeEvents, persistBalanceEffect } from './settlement-persistence';
import { type WagerResult, replayOrConflict, resultOf } from './wager-result';

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/** Presente quando a entrada é o consumidor SQS. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
  /** Hash do conteúdo da mensagem; mesmo messageId com hash diferente = conflito. */
  payloadHash: string;
}

/** Observa resultados aplicados (métricas e reprocessamento de dependentes). */
export interface WagerOutcomeListener {
  /** Chamado DEPOIS do commit. Não pode lançar nem bloquear a resposta. */
  onCommitted(tx: WagerTransaction, result: WagerResult): void;
  onDuplicate(): void;
}

export interface SubmitOutcome {
  result: WagerResult;
  /** A mensagem SQS já tinha sido processada (inbox): só dar ack. */
  duplicateMessage: boolean;
}

export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: PendingReferencePolicy,
    private readonly listener?: WagerOutcomeListener,
    private readonly identity: ProviderIdentityPort = new AllowAllProviderIdentity(),
  ) {}

  async execute(
    command: SubmitWagerCommand,
    ctx: OperationContext,
    inbox?: InboxContext,
  ): Promise<SubmitOutcome> {
    // Ponto de extensão de autenticação (enunciado §2): stub permissivo hoje.
    await this.identity.authorize(ctx.principal, command.providerId);
    const at = this.clock.now();
    const candidate = this.buildCandidate(command, at);

    try {
      const outcome = await this.uow.run((scope) => this.process(scope, candidate, ctx, inbox, at));
      if (outcome.result.idempotentReplay) this.listener?.onDuplicate();
      else this.listener?.onCommitted(candidate, outcome.result);
      return outcome;
    } catch (error: unknown) {
      // Erros esperados (400/404/409, transitório, conflito de inbox) passam direto.
      if (error instanceof ApplicationError) throw error;
      // Inesperado e permanente: a transação original sofreu rollback; gravamos
      // FAILED numa transação própria para ficar auditável (taxonomia §8.1).
      return this.recordFailure(command, inbox, error, FailureCode.InternalPermanentError);
    }
  }

  private buildCandidate(command: SubmitWagerCommand, at: Date): WagerTransaction {
    if (!SUBMITTABLE_KINDS.includes(command.kind)) {
      throw new InvalidPayloadError(`kind ${command.kind} não pode ser submetido`);
    }
    try {
      return WagerTransaction.create({ id: this.ids.next(), ...command, createdAt: at });
    } catch (error: unknown) {
      // Ex.: REFUND sem referência, BET com valor 0: payload inválido (400), sem linha.
      if (error instanceof DomainError) throw new InvalidPayloadError(error.message);
      throw error;
    }
  }

  private async process(
    scope: TransactionScope,
    candidate: WagerTransaction,
    ctx: OperationContext,
    inbox: InboxContext | undefined,
    at: Date,
  ): Promise<SubmitOutcome> {
    // 1. Restrição #7: lock da wallet ANTES de ler saldo e ANTES de consultar a
    // idempotência. Duas cópias da mesma operação na mesma wallet ficam
    // serializadas aqui; a segunda só lê depois do commit da primeira e vira replay.
    const wallet = await scope.wallets.lockById(candidate.walletId);
    if (wallet === undefined) {
      // A key/externalId pode já existir com OUTRA wallet: isso é conflito de
      // idempotência (409), não "wallet inexistente" (404).
      const existing = await scope.transactions.findByIdentity(
        candidate.providerId,
        candidate.idempotencyKey,
        candidate.externalTransactionId,
      );
      if (existing.length > 0) {
        throw new IdempotencyConflictError(
          'Idempotency-Key/externalTransactionId já registrados com outra wallet',
        );
      }
      throw new WalletNotFoundError(candidate.walletId);
    }
    const balanceBefore = wallet.balance;

    // 2. Inbox (só SQS): gravada já como processada, no mesmo commit do efeito.
    // Se o commit falhar, ela some junto e a redelivery reprocessa.
    let duplicateMessage = false;
    if (inbox !== undefined) {
      const message = InboxMessage.receive({ ...inbox, receivedAt: at });
      message.markProcessed(at);
      if (!(await scope.inbox.insertIfAbsent(message))) {
        const existing = await scope.inbox.find(inbox.consumerName, inbox.messageId);
        if (existing !== undefined && !existing.matchesPayload(inbox.payloadHash)) {
          throw new InboxConflictError(inbox.messageId);
        }
        duplicateMessage = true;
      }
    }

    // 3. Idempotência persistente (Restrição #2): replay ou conflito.
    const existing = await scope.transactions.findByIdentity(
      candidate.providerId,
      candidate.idempotencyKey,
      candidate.externalTransactionId,
    );
    if (existing.length > 0) {
      return { result: replayOrConflict(existing, candidate, balanceBefore), duplicateMessage };
    }

    // 4. Referência: travada DEPOIS da wallet (ordem fixa, sem deadlock).
    const reference =
      candidate.hasReference() && candidate.referenceExternalTransactionId !== undefined
        ? await scope.transactions.lockByExternalId(
            candidate.providerId,
            candidate.referenceExternalTransactionId,
          )
        : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && (await scope.transactions.hasProcessedReversal(reference.id));

    // 5. Regras de negócio puras (mutam wallet e candidate em memória).
    const { ledgerEntry } = settle({
      wallet,
      transaction: candidate,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      policy: this.policy,
      at,
    });

    // 6. Última linha de defesa contra duplicidade. 0 linhas = outra transação
    // gravou a mesma key/externalId (por exemplo, com walletId diferente, que
    // trava outra linha). Nada foi escrito ainda: relemos e decidimos.
    if (!(await scope.transactions.insertIfAbsent(candidate))) {
      const raced = await scope.transactions.findByIdentity(
        candidate.providerId,
        candidate.idempotencyKey,
        candidate.externalTransactionId,
      );
      if (raced.length === 0) {
        // Colisão no índice D1 (uq_tx_single_reversal) sem linha com a mesma
        // chave. Repetir resolve: a releitura sob lock verá ALREADY_REVERSED.
        throw new ConcurrentInsertConflictError('Conflito de unicidade concorrente; repita');
      }
      return { result: replayOrConflict(raced, candidate, balanceBefore), duplicateMessage };
    }

    // 7. Efeitos no mesmo commit.
    await persistBalanceEffect(scope, wallet, ledgerEntry);
    await enqueueOutcomeEvents(scope, this.ids, ctx, at, wallet, candidate, ledgerEntry, true);
    return { result: resultOf(candidate, wallet.balance, false), duplicateMessage };
  }

  private async recordFailure(
    command: SubmitWagerCommand,
    inbox: InboxContext | undefined,
    original: unknown,
    code: FailureCode,
  ): Promise<SubmitOutcome> {
    const at = this.clock.now();
    try {
      return await this.uow.run(async (scope) => {
        const wallet = await scope.wallets.lockById(command.walletId);
        if (wallet === undefined) throw original;
        const existing = await scope.transactions.findByIdentity(
          command.providerId,
          command.idempotencyKey,
          command.externalTransactionId,
        );
        // Outra entrega concluiu nesse meio-tempo: devolve o resultado dela.
        const fresh = WagerTransaction.create({ id: this.ids.next(), ...command, createdAt: at });
        if (existing.length > 0) {
          return {
            result: replayOrConflict(existing, fresh, wallet.balance),
            duplicateMessage: false,
          };
        }
        fresh.fail(code, { observedBalance: wallet.balance, at });
        if (inbox !== undefined) {
          const message = InboxMessage.receive({ ...inbox, receivedAt: at });
          message.markProcessed(at);
          await scope.inbox.insertIfAbsent(message);
        }
        if (!(await scope.transactions.insertIfAbsent(fresh))) throw original;
        return { result: resultOf(fresh, wallet.balance, false), duplicateMessage: false };
      });
    } catch (error: unknown) {
      // Se nem o FAILED pôde ser gravado (ex.: banco caiu), prevalece a
      // classificação do erro de registro (transitório -> 503/retry).
      if (error instanceof ApplicationError) throw error;
      throw original;
    }
  }
}

export function httpStatusOf(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}
