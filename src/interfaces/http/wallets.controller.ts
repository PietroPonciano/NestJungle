import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { CreateWalletUseCase, WalletView } from '../../application/use-cases/create-wallet';
import type { LedgerEntryView, WalletQueries } from '../../application/use-cases/queries';
import type {
  ReconcileWalletUseCase,
  ReconciliationReport,
} from '../../application/use-cases/reconcile-wallet';
import { TOKENS } from '../../shared/tokens';
import { AuthGuard } from './auth.guard';
import {
  decodeCursor,
  encodeCursor,
  parseCreateWallet,
  parseLimit,
  parseUuidParam,
} from './http-parsers';

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(TOKENS.CreateWallet) private readonly createWallet: CreateWalletUseCase,
    @Inject(TOKENS.Queries) private readonly queries: WalletQueries,
    @Inject(TOKENS.Reconcile) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  /** Saldo armazenado × reconstruído pelo ledger. Divergência: consistent=false (nunca corrige). */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string): Promise<ReconciliationReport> {
    return this.reconcile.execute(parseUuidParam(walletId, 'walletId'));
  }

  /** 201 criada · 409 duplicada (player + moeda) · 400 inválida · 503 transitória. */
  @Post()
  @HttpCode(201)
  create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId: string,
  ): Promise<WalletView> {
    return this.createWallet.execute(parseCreateWallet(body), { correlationId });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.getWallet(parseUuidParam(walletId, 'walletId'));
  }

  /** Paginação por cursor opaco e estável (baseado em seq). */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<{ walletId: string; entries: LedgerEntryView[]; nextCursor: string | null }> {
    const page = await this.queries.getLedger(
      parseUuidParam(walletId, 'walletId'),
      decodeCursor(cursor),
      parseLimit(limit),
    );
    return {
      walletId: page.walletId,
      entries: page.entries,
      nextCursor: encodeCursor(page.nextAfterSeq),
    };
  }
}
