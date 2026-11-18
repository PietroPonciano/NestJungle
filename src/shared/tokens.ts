/**
 * Tokens de injeção. O Bun não emite `emitDecoratorMetadata` (guia §2.2;
 * decisão E7), então TODA injeção usa @Inject(TOKEN) explícito. Nunca se
 * confia em injeção por tipo refletido.
 */
export const TOKENS = {
  Logger: Symbol('AppLogger'),
  Metrics: Symbol('AppMetrics'),
  CreateWallet: Symbol('CreateWalletUseCase'),
  SubmitWager: Symbol('SubmitWagerTransactionUseCase'),
  Queries: Symbol('WalletQueries'),
  Reconcile: Symbol('ReconcileWalletUseCase'),
  Health: Symbol('HealthService'),
} as const;
