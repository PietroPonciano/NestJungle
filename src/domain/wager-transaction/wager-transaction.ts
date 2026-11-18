/**
 * WagerTransaction — ciclo de vida de uma operação de aposta.
 *
 * Invariantes encapsuladas:
 *  - Nasce em PENDING (`create`). OPENING é interno: só nasce por `opening()`,
 *    nunca por `create()` (enunciado §6.3).
 *  - REFUND e ROLLBACK exigem referenceExternalTransactionId (regra 1;
 *    CHECK ck_tx_reference_required). WIN aceita, mas não exige.
 *  - Valor: LOSS aceita 0; os demais exigem > 0 (D4; CHECK ck_tx_amount).
 *    Nunca negativo.
 *  - payloadHash é calculado AQUI, a partir dos próprios campos de negócio,
 *    então não há como o hash gravado divergir do payload gravado.
 *  - Máquina de estados (transições válidas):
 *        PENDING           -> PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *        PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 *        PENDING_REFERENCE -> PENDING_REFERENCE (reagendamento, attempts + 1)
 *        PROCESSED | REJECTED | FAILED -> (terminais)
 *    Qualquer outra transição lança InvalidTransactionStateError (erro de
 *    programação, não caminho de negócio).
 *  - REJECTED sempre com código de categoria BUSINESS; FAILED sempre com
 *    código PERMANENT; os demais estados nunca têm código (CHECK ck_tx_failure_code).
 *  - processedAt existe se e somente se status = PROCESSED (CHECK ck_tx_processed_at).
 *  - observedBalance é o saldo da wallet quando a transação ficou terminal; é o
 *    que o replay devolve (regra 7; D6).
 *  - `rehydrate` reconstrói o estado persistido sem revalidar transições.
 */
import { Money } from '../money/money';
import { InvalidTransactionStateError, InvariantViolationError } from '../shared/domain-error';
import { LedgerDirection, invertDirection } from '../wallet/ledger-direction';
import { FailureCategory, type FailureCode, categoryOf } from './failure-code';
import { computePayloadHash } from './payload-hash';
import type { PendingReferenceSchedule } from './pending-reference-policy';
import {
  TERMINAL_STATUSES,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction-kind';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  payloadHash: string;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  observedBalance: Money | undefined;
  attempts: number;
  nextAttemptAt: Date | undefined;
  expiresAt: Date | undefined;
  processedAt: Date | undefined;
  updatedAt: Date;
}

export interface OpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

/** Valores internos da OPENING (decisão E3 no ARCHITECTURE.md). */
export const INTERNAL_PROVIDER_ID = 'internal';
const OPENING_ROUND_ID = 'opening';

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _observedBalance: Money | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _expiresAt: Date | undefined,
    private _processedAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Operação submetida por provedor (HTTP ou SQS). Nasce em PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvariantViolationError('OPENING é interno e não pode ser submetido');
    }
    return WagerTransaction.newPending(props);
  }

  /**
   * OPENING interno da criação de wallet: nasce PENDING e é marcado PROCESSED
   * pelo use case, na mesma transação SQL da wallet e do lançamento.
   */
  static opening(props: OpeningProps): WagerTransaction {
    const key = `opening:${props.walletId}`;
    return WagerTransaction.newPending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: OPENING_ROUND_ID,
      gameId: OPENING_ROUND_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.observedBalance,
      state.attempts,
      state.nextAttemptAt,
      state.expiresAt,
      state.processedAt,
      state.updatedAt,
    );
  }

  private static newPending(props: CreateWagerTransactionProps): WagerTransaction {
    const requiresReference = kindRequiresReference(props.kind);
    const reference = props.referenceExternalTransactionId;
    if (requiresReference && (reference === undefined || reference === '')) {
      throw new InvariantViolationError(`${props.kind} exige referenceExternalTransactionId`);
    }
    if (props.money.isNegative()) {
      throw new InvariantViolationError('Valor da transação não pode ser negativo');
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvariantViolationError(`${props.kind} exige valor > 0 (só LOSS aceita 0)`);
    }
    for (const [field, value] of Object.entries({
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      roundId: props.roundId,
      gameId: props.gameId,
    })) {
      if (value.trim() === '') throw new InvariantViolationError(`${field} é obrigatório`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      computePayloadHash(props),
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference === '' ? undefined : reference,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
      props.createdAt,
    );
  }

  // ---------------------------------------------------------------- getters
  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get expiresAt(): Date | undefined {
    return this._expiresAt;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ------------------------------------------------------------- transições
  markProcessed(props: {
    referenceTransactionId: string | undefined;
    observedBalance: Money;
    at: Date;
  }): void {
    this.assertTransition(WagerTransactionStatus.Processed);
    if (this.requiresReference() && props.referenceTransactionId === undefined) {
      throw new InvariantViolationError(`${this.kind} só é processado com referência resolvida`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._observedBalance = props.observedBalance;
    this._processedAt = props.at;
    this.leavePendingReference(props.at);
  }

  markPendingReference(schedule: PendingReferenceSchedule, at: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        WagerTransactionStatus.PendingReference,
      );
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError('PENDING_REFERENCE sem referência a aguardar');
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = schedule.nextAttemptAt;
    this._expiresAt = schedule.expiresAt;
    this._updatedAt = at;
  }

  /** Worker de pendências: referência ainda ausente; reagenda com backoff. */
  scheduleReferenceRetry(nextAttemptAt: Date, at: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        WagerTransactionStatus.PendingReference,
      );
    }
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    this._updatedAt = at;
  }

  reject(
    code: FailureCode,
    props: { observedBalance: Money; at: Date; referenceTransactionId?: string | undefined },
  ): void {
    this.assertTransition(WagerTransactionStatus.Rejected);
    if (categoryOf(code) !== FailureCategory.Business) {
      throw new InvariantViolationError(`${code} não é código de rejeição de negócio`);
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = props.observedBalance;
    // Guardar a referência resolvida mesmo na rejeição ajuda a auditoria
    // (ex.: AMOUNT_MISMATCH). O índice D1 só considera reversões PROCESSED.
    this._referenceTransactionId = props.referenceTransactionId;
    this.leavePendingReference(props.at);
  }

  fail(code: FailureCode, props: { observedBalance: Money | undefined; at: Date }): void {
    this.assertTransition(WagerTransactionStatus.Failed);
    if (categoryOf(code) !== FailureCategory.Permanent) {
      throw new InvariantViolationError(`${code} não é código de falha permanente`);
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._observedBalance = props.observedBalance;
    this.leavePendingReference(props.at);
  }

  // -------------------------------------------------------------- consultas
  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /** false para LOSS: registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK (regra 1). */
  requiresReference(): boolean {
    return kindRequiresReference(this.kind);
  }

  /** Referência a resolver: obrigatória em REFUND/ROLLBACK, opcional em WIN (decisão E2). */
  hasReference(): boolean {
    return (
      this.referenceExternalTransactionId !== undefined &&
      (this.requiresReference() || this.kind === WagerTransactionKind.Win)
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento:
   *   BET -> DEBIT; WIN, REFUND, OPENING -> CREDIT;
   *   ROLLBACK -> inverso da direção da referência (BET, WIN ou REFUND).
   * LOSS não gera lançamento: perguntar a direção dela é erro de programação.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new InvariantViolationError('ROLLBACK exige a referência para definir a direção');
        }
        if (
          reference.kind !== WagerTransactionKind.Bet &&
          reference.kind !== WagerTransactionKind.Win &&
          reference.kind !== WagerTransactionKind.Refund
        ) {
          throw new InvariantViolationError(`ROLLBACK não reverte ${reference.kind}`);
        }
        return invertDirection(reference.ledgerDirectionFor());
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS não gera lançamento no ledger');
    }
  }

  // ---------------------------------------------------------------- privado
  private assertTransition(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, to);
    }
  }

  private leavePendingReference(at: Date): void {
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }
}

function kindRequiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}
