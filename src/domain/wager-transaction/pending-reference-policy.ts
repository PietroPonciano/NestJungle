/**
 * Política de reprocessamento de PENDING_REFERENCE (enunciado §7.1; guia §4.6).
 *
 * Invariantes:
 *  - Backoff exponencial: delay(n) = min(base · 2^n, max), em que n é o número
 *    de tentativas já feitas pelo worker.
 *  - Termina SEMPRE: a transação expira quando atinge maxAttempts OU passa do
 *    expiresAt (TTL), o que vier primeiro. Ao expirar, vira REJECTED com
 *    REFERENCE_NOT_FOUND.
 *  - Padrão: TTL 1 h, base 2 s, teto 5 min, 20 tentativas. Provedores
 *    at-least-once reordenam em segundos ou minutos; 1 h cobre atrasos
 *    realistas sem acumular pendências indefinidamente.
 */
export interface PendingReferencePolicyConfig {
  ttlMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicyConfig = {
  ttlMs: 60 * 60 * 1000,
  baseDelayMs: 2_000,
  maxDelayMs: 5 * 60 * 1000,
  maxAttempts: 20,
};

export interface PendingReferenceSchedule {
  nextAttemptAt: Date;
  expiresAt: Date;
}

export class PendingReferencePolicy {
  constructor(private readonly config: PendingReferencePolicyConfig) {}

  /** Agenda inicial quando a transação entra em PENDING_REFERENCE. */
  initial(now: Date): PendingReferenceSchedule {
    return {
      nextAttemptAt: this.nextAttemptAt(0, now),
      expiresAt: new Date(now.getTime() + this.config.ttlMs),
    };
  }

  /** Próxima tentativa depois de `attemptsDone` tentativas. */
  nextAttemptAt(attemptsDone: number, now: Date): Date {
    // 2^n cresce rápido; o min com o teto evita overflow prático de Date.
    const exponential = this.config.baseDelayMs * 2 ** Math.min(attemptsDone, 30);
    return new Date(now.getTime() + Math.min(exponential, this.config.maxDelayMs));
  }

  isExhausted(attemptsDone: number, expiresAt: Date, now: Date): boolean {
    return attemptsDone >= this.config.maxAttempts || now.getTime() >= expiresAt.getTime();
  }
}
