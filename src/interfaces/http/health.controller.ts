import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthReport, HealthService } from '../../container';
import type { AppMetrics } from '../../shared/metrics';
import { TOKENS } from '../../shared/tokens';

/**
 * Health e métricas: ABERTOS, sem AuthGuard (enunciado §2 e §9).
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(TOKENS.Health) private readonly health: HealthService,
    @Inject(TOKENS.Metrics) private readonly metrics: AppMetrics,
  ) {}

  /** Liveness não consulta dependências: banco fora não deve reiniciar o processo. */
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL (SELECT 1) e SQS alcançáveis; 503 se algum não estiver. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metricsText(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
