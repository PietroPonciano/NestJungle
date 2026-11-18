/**
 * Laço de polling genérico para os workers (outbox, pendências).
 *
 * - Uma iteração por vez (sem sobreposição dentro da instância). A
 *   concorrência ENTRE instâncias é resolvida no banco (SKIP LOCKED).
 * - Se a iteração fez trabalho, roda de novo logo em seguida (drena o
 *   backlog). Se não fez nada, espera `intervalMs`.
 * - stop() espera a iteração em andamento terminar (shutdown gracioso).
 */
export interface WorkerLogger {
  error(message: string, context: Record<string, unknown>): void;
}

export class PollingWorker {
  private running = false;
  private current: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    /** Devolve true se processou algo (então roda de novo imediatamente). */
    private readonly tick: () => Promise<boolean>,
    private readonly logger: WorkerLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.current;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.current = this.runOnce();
    }, delayMs);
  }

  private async runOnce(): Promise<void> {
    let didWork = false;
    try {
      didWork = await this.tick();
    } catch (error: unknown) {
      // Erro de uma iteração (ex.: banco fora) não derruba o worker; tenta de novo depois.
      this.logger.error(`worker ${this.name} falhou`, { error: String(error) });
    }
    this.schedule(didWork ? 0 : this.intervalMs);
  }
}
