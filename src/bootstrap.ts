import 'reflect-metadata';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { type Container, buildContainer } from './container';
import { type AppConfig, loadConfig } from './infrastructure/config/app-config';
import { HttpExceptionFilter } from './interfaces/http/http-exception.filter';
import type { AppLogger } from './shared/logger';

/** Adapta o logger do Nest ao logger JSON (todas as linhas saem em JSON). */
class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: AppLogger) {}
  log(message: unknown, context?: unknown): void {
    this.logger.debug(String(message), { context: String(context) });
  }
  error(message: unknown, trace?: unknown, context?: unknown): void {
    this.logger.error(String(message), { trace: String(trace), context: String(context) });
  }
  warn(message: unknown, context?: unknown): void {
    this.logger.warn(String(message), { context: String(context) });
  }
}

const CORRELATION_HEADER = 'x-correlation-id';
const VALID_CORRELATION = /^[\w.:-]{1,128}$/;

export interface CreatedApp {
  app: INestApplication;
  container: Container;
}

/**
 * Cria a aplicação sem chamar listen(). Os testes HTTP reais sobem exatamente
 * a mesma app (mesmos módulos e filtro) numa porta efêmera.
 */
export async function createApp(
  config: AppConfig = loadConfig(),
  options: { logger?: AppLogger } = {},
): Promise<CreatedApp> {
  const container = await buildContainer(config, options.logger);
  const app = await NestFactory.create(AppModule.forRoot(container), {
    logger: new NestJsonLogger(container.logger),
  });

  // CorrelationId: vem do header (se válido) ou é gerado; volta na resposta e
  // segue para os eventos (correlationId do envelope).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      typeof incoming === 'string' && VALID_CORRELATION.test(incoming)
        ? incoming
        : Bun.randomUUIDv7();
    req.headers[CORRELATION_HEADER] = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    // Log estruturado de cada requisição: método, rota, status, duração e
    // correlationId. Sem corpo (nada de payload financeiro em log).
    const started = performance.now();
    res.on('finish', () => {
      container.logger.info('requisição HTTP', {
        correlationId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      });
    });
    next();
  });
  app.useGlobalFilters(new HttpExceptionFilter(container.logger));
  // SIGTERM/SIGINT disparam beforeApplicationShutdown: o consumidor conclui a
  // mensagem em andamento (commit + ack) ou devolve a visibilidade (§10).
  app.enableShutdownHooks();
  return { app, container };
}
