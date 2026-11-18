import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { TransactionView, WalletQueries } from '../../application/use-cases/queries';
import {
  type SubmitWagerTransactionUseCase,
  httpStatusOf,
} from '../../application/use-cases/submit-wager-transaction';
import type { WagerResult } from '../../application/use-cases/wager-result';
import type { AppLogger } from '../../shared/logger';
import type { AppMetrics } from '../../shared/metrics';
import { TOKENS } from '../../shared/tokens';
import { parseIdempotencyKey, parseWagerFields } from '../shared/payload-parsers';
import { AuthGuard } from './auth.guard';
import { parseUuidParam } from './http-parsers';

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(TOKENS.SubmitWager) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(TOKENS.Queries) private readonly queries: WalletQueries,
    @Inject(TOKENS.Metrics) private readonly metrics: AppMetrics,
    @Inject(TOKENS.Logger) private readonly logger: AppLogger,
  ) {}

  /**
   * Status (guia §7.3): 201 processada · 200 replay · 202 PENDING_REFERENCE ·
   * 422 REJECTED (failureCode no corpo) · 500 FAILED · 400/404/409/503 pelo filtro.
   */
  @Post('wagering/transactions')
  async submitTransaction(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    const started = performance.now();
    // O header Idempotency-Key é obrigatório e é a fonte da verdade (enunciado §9).
    const command = parseWagerFields(body, parseIdempotencyKey(idempotencyKey), 'Corpo');
    const { result } = await this.submit.execute(command, { correlationId });
    this.metrics.processingDuration.observe(
      { source: 'http' },
      (performance.now() - started) / 1000,
    );
    this.logger.info('transação submetida via HTTP', {
      correlationId,
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      kind: command.kind,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
    res.status(httpStatusOf(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  getTransaction(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    return this.queries.getTransaction(parseUuidParam(transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.queries.getByExternalId(providerId, externalTransactionId);
  }
}
