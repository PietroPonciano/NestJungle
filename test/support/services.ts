/** Monta os use cases reais (PostgreSQL real, sem mocks) para testes de integração. */
import type { MikroORM } from '@mikro-orm/postgresql';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet';
import {
  CompositeOutcomeListener,
  PendingReferenceProcessor,
} from '../../src/application/use-cases/pending-reference-processor';
import {
  type SubmitWagerCommand,
  SubmitWagerTransactionUseCase,
} from '../../src/application/use-cases/submit-wager-transaction';
import { Money } from '../../src/domain/money/money';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  PendingReferencePolicy,
} from '../../src/domain/wager-transaction/pending-reference-policy';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';

export function buildServices(
  orm: MikroORM,
  lockTimeoutMs = 5000,
  policy = new PendingReferencePolicy(DEFAULT_PENDING_REFERENCE_POLICY),
  options: { immediateDependents?: boolean } = {},
) {
  const uow = new MikroOrmUnitOfWork(orm, lockTimeoutMs);
  const ids = new UuidV7Generator();
  const clock = new SystemClock();
  const pending = new PendingReferenceProcessor(uow, ids, clock, policy, {
    error: (msg, fields) => {
      console.error(msg, fields);
    },
  });
  const listener = new CompositeOutcomeListener();
  if (options.immediateDependents === true) listener.add(pending);
  return {
    uow,
    ids,
    clock,
    policy,
    pending,
    createWallet: new CreateWalletUseCase(uow, ids, clock),
    submit: new SubmitWagerTransactionUseCase(uow, ids, clock, policy, listener),
  };
}

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export function wagerCommand(
  wallet: { id: string; playerId: string },
  kind: WagerTransactionKind,
  amount: string,
  over: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  const ext = over.externalTransactionId ?? `tx-${Bun.randomUUIDv7()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    ...over,
  };
}

export { WagerTransactionKind as K };
