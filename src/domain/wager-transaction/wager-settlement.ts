/**
 * Liquidação de uma WagerTransaction contra a Wallet — regras de negócio puras
 * (enunciado §7; guia §4.6).
 *
 * Invariantes:
 *  - `decideSettlement` é função pura: só lê e devolve uma decisão. `settle`
 *    aplica a decisão em memória (wallet + transação). Persistir, travar e
 *    publicar são responsabilidade do use case.
 *  - PRÉ-CONDIÇÃO (Restrição #7): quem chama já travou a wallet (FOR UPDATE)
 *    e carregou o saldo depois do lock. Aqui não há leitura de banco.
 *  - REJECTED não altera saldo nem gera ledger (regra 6). LOSS é PROCESSED
 *    sem lançamento.
 *  - Ordem de avaliação (a primeira violação vence):
 *      1. moeda ≠ moeda da wallet          -> CURRENCY_MISMATCH
 *      2. player ≠ player da wallet         -> PLAYER_MISMATCH
 *      3. sem referência: BET (saldo -> INSUFFICIENT_FUNDS), WIN (crédito),
 *         LOSS (registro)
 *      4. com referência (REFUND/ROLLBACK obrigatória; WIN opcional, E2):
 *         a. referência inexistente         -> aguardar (PENDING_REFERENCE; regra 8)
 *         b. kind não referenciável         -> REFERENCE_INVALID_KIND (regra 3)
 *         c. provider/player/wallet/rodada  -> REFERENCE_MISMATCH (regra 2)
 *         d. moeda da referência            -> CURRENCY_MISMATCH (regra 2)
 *         e. referência PENDING/PENDING_REFERENCE -> aguardar
 *         f. referência REJECTED/FAILED     -> REFERENCE_NOT_PROCESSED (D2)
 *         g. REFUND/ROLLBACK: valor ≠       -> AMOUNT_MISMATCH (regra 5)
 *         h. REFUND/ROLLBACK: já revertida  -> ALREADY_REVERSED (regra 4 / D1)
 *         i. reversão que debita além do saldo -> REVERSAL_WOULD_OVERDRAW (regra 9),
 *            distinto de INSUFFICIENT_FUNDS
 *  - Todo crédito (WIN, REFUND, ROLLBACK de débito) que levaria o saldo além do
 *    limite de NUMERIC(18,2) -> BALANCE_LIMIT_EXCEEDED. É um limite previsível,
 *    não falha de infraestrutura: sem esta checagem viraria FAILED/500.
 *    b–d vêm antes de e: são propriedades imutáveis da referência, então não
 *    adianta esperar ela terminar para rejeitar.
 *  - PENDING_REFERENCE expirada (tentativas/TTL) -> REJECTED com REFERENCE_NOT_FOUND.
 *  - D1 (`referenceAlreadyReversed`) é calculado pelo repositório sob o lock da
 *    wallet; o índice único parcial uq_tx_single_reversal é a última linha de defesa.
 */
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { LedgerDirection } from '../wallet/ledger-direction';
import { InvariantViolationError } from '../shared/domain-error';
import { FailureCode } from './failure-code';
import type { PendingReferencePolicy } from './pending-reference-policy';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionKind as K, WagerTransactionStatus as S } from './wager-transaction-kind';

export type SettlementDecision =
  | { type: 'APPLY'; direction: LedgerDirection; referenceTransactionId: string | undefined }
  | { type: 'RECORD_ONLY' }
  | { type: 'REJECT'; code: FailureCode; referenceTransactionId: string | undefined }
  | { type: 'AWAIT_REFERENCE' };

export interface SettlementContext {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined se não existe. */
  reference: WagerTransaction | undefined;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para a referência (D1). */
  referenceAlreadyReversed: boolean;
}

export interface SettleProps extends SettlementContext {
  ledgerEntryId: string;
  policy: PendingReferencePolicy;
  at: Date;
}

export interface SettlementResult {
  decision: SettlementDecision;
  /** Presente só quando o saldo mudou. */
  ledgerEntry: WalletLedgerEntry | undefined;
}

const REFERENCEABLE_KINDS: Readonly<Partial<Record<K, readonly K[]>>> = {
  [K.Refund]: [K.Bet],
  [K.Rollback]: [K.Bet, K.Win, K.Refund],
  [K.Win]: [K.Bet],
};

export function decideSettlement(ctx: SettlementContext): SettlementDecision {
  const { wallet, transaction: tx, reference: ref } = ctx;
  assertPreconditions(ctx);

  const reject = (code: FailureCode, referenceTransactionId?: string): SettlementDecision => ({
    type: 'REJECT',
    code,
    referenceTransactionId,
  });

  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.PlayerMismatch);

  if (!tx.hasReference()) {
    switch (tx.kind) {
      case K.Bet:
        return wallet.canDebit(tx.money)
          ? { type: 'APPLY', direction: LedgerDirection.Debit, referenceTransactionId: undefined }
          : reject(FailureCode.InsufficientFunds);
      case K.Win:
        return wallet.canCredit(tx.money)
          ? { type: 'APPLY', direction: LedgerDirection.Credit, referenceTransactionId: undefined }
          : reject(FailureCode.BalanceLimitExceeded);
      case K.Loss:
        return { type: 'RECORD_ONLY' };
      default:
        throw new InvariantViolationError(`${tx.kind} sem referência não é liquidável`);
    }
  }

  if (ref === undefined) return { type: 'AWAIT_REFERENCE' };

  const allowed = REFERENCEABLE_KINDS[tx.kind] ?? [];
  if (!allowed.includes(ref.kind)) return reject(FailureCode.ReferenceInvalidKind, ref.id);

  if (
    ref.providerId !== tx.providerId ||
    ref.playerId !== tx.playerId ||
    ref.walletId !== tx.walletId ||
    ref.roundId !== tx.roundId
  ) {
    return reject(FailureCode.ReferenceMismatch, ref.id);
  }
  if (ref.money.currency !== tx.money.currency) return reject(FailureCode.CurrencyMismatch, ref.id);

  if (ref.status === S.Pending || ref.status === S.PendingReference) {
    return { type: 'AWAIT_REFERENCE' };
  }
  if (ref.status !== S.Processed) return reject(FailureCode.ReferenceNotProcessed, ref.id);

  if (tx.requiresReference()) {
    if (!tx.money.equals(ref.money)) return reject(FailureCode.AmountMismatch, ref.id);
    if (ctx.referenceAlreadyReversed) return reject(FailureCode.AlreadyReversed, ref.id);
  }

  const direction = tx.ledgerDirectionFor(ref);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    // Regra 9: código distinto de INSUFFICIENT_FUNDS — é incidente operacional.
    return reject(FailureCode.ReversalWouldOverdraw, ref.id);
  }
  if (direction === LedgerDirection.Credit && !wallet.canCredit(tx.money)) {
    return reject(FailureCode.BalanceLimitExceeded, ref.id);
  }
  return { type: 'APPLY', direction, referenceTransactionId: ref.id };
}

/**
 * Aplica a decisão em memória. Saldo e ledger mudam juntos (um lançamento por
 * alteração) e a transação vai para o estado correspondente, com o saldo
 * observado DEPOIS do efeito (é o que o replay devolve — regra 7).
 */
export function settle(props: SettleProps): SettlementResult {
  const { wallet, transaction: tx, at } = props;
  const decision = decideSettlement(props);

  switch (decision.type) {
    case 'APPLY': {
      const movement = {
        entryId: props.ledgerEntryId,
        transactionId: tx.id,
        money: tx.money,
        at,
      };
      const ledgerEntry =
        decision.direction === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
      tx.markProcessed({
        referenceTransactionId: decision.referenceTransactionId,
        observedBalance: wallet.balance,
        at,
      });
      return { decision, ledgerEntry };
    }
    case 'RECORD_ONLY':
      tx.markProcessed({ referenceTransactionId: undefined, observedBalance: wallet.balance, at });
      return { decision, ledgerEntry: undefined };
    case 'REJECT':
      tx.reject(decision.code, {
        observedBalance: wallet.balance,
        at,
        referenceTransactionId: decision.referenceTransactionId,
      });
      return { decision, ledgerEntry: undefined };
    case 'AWAIT_REFERENCE':
      awaitReference(tx, wallet, props.policy, at);
      return { decision, ledgerEntry: undefined };
  }
}

function awaitReference(
  tx: WagerTransaction,
  wallet: Wallet,
  policy: PendingReferencePolicy,
  at: Date,
): void {
  if (tx.status === S.Pending) {
    tx.markPendingReference(policy.initial(at), at);
    return;
  }
  // Já estava em PENDING_REFERENCE: esta é mais uma tentativa do worker.
  const attemptsDone = tx.attempts + 1;
  const expiresAt = tx.expiresAt ?? at;
  if (policy.isExhausted(attemptsDone, expiresAt, at)) {
    tx.reject(FailureCode.ReferenceNotFound, { observedBalance: wallet.balance, at });
    return;
  }
  tx.scheduleReferenceRetry(policy.nextAttemptAt(attemptsDone, at), at);
}

function assertPreconditions(ctx: SettlementContext): void {
  if (ctx.transaction.isTerminal()) {
    throw new InvariantViolationError('Transação terminal não pode ser liquidada de novo');
  }
  if (ctx.transaction.walletId !== ctx.wallet.id) {
    throw new InvariantViolationError('Transação e wallet não correspondem');
  }
  if (ctx.transaction.kind === K.Opening) {
    throw new InvariantViolationError('OPENING é liquidado na criação da wallet');
  }
}
