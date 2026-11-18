/**
 * Filtro de exceção ÚNICO: mapeia erros para a tabela de status do guia §7.3,
 * de forma consistente em todos os endpoints.
 *
 *   400 INVALID_PAYLOAD          payload/header/cursor inválido
 *   404 *_NOT_FOUND              wallet/transação inexistente, rota inexistente
 *   403 PROVIDER_NOT_AUTHORIZED        principal não pode agir como o provedor
 *   409 WALLET_ALREADY_EXISTS / IDEMPOTENCY_CONFLICT
 *   413 PAYLOAD_TOO_LARGE        corpo acima do limite do body parser
 *   503 TRANSIENT_INFRASTRUCTURE_ERROR + Retry-After (reenviar com a mesma key)
 *   500 INTERNAL_ERROR           inesperado
 *
 * 422 (REJECTED), 202 (PENDING_REFERENCE) e o 500 de FAILED gravado NÃO passam
 * por aqui: são resultados normais do use case, devolvidos pelo controller.
 */
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidPayloadError,
  ProviderNotAuthorizedError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { isTransientDbError } from '../../infrastructure/persistence/db-errors';
import type { AppLogger } from '../../shared/logger';

interface ErrorBody {
  error: string;
  message: string;
  details?: readonly string[];
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body, retryAfter } = this.map(exception);
    if (status >= 500) {
      this.logger.error('erro na requisição HTTP', {
        status,
        error: body.error,
        detail: exception instanceof Error ? exception.message : String(exception),
      });
    }
    if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    res.status(status).json(body);
  }

  private map(exception: unknown): { status: number; body: ErrorBody; retryAfter?: number } {
    if (exception instanceof InvalidPayloadError) {
      return {
        status: 400,
        body: { error: exception.code, message: exception.message, details: exception.details },
      };
    }
    if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      return { status: 404, body: { error: exception.code, message: exception.message } };
    }
    if (
      exception instanceof WalletAlreadyExistsError ||
      exception instanceof IdempotencyConflictError
    ) {
      return { status: 409, body: { error: exception.code, message: exception.message } };
    }
    if (exception instanceof ProviderNotAuthorizedError) {
      return { status: 403, body: { error: exception.code, message: exception.message } };
    }
    if (exception instanceof TransientInfrastructureError) {
      return {
        status: 503,
        body: {
          error: exception.code,
          message: 'Falha transitória; reenvie com a mesma Idempotency-Key',
        },
        retryAfter: exception.retryAfterSeconds,
      };
    }
    if (exception instanceof ApplicationError) {
      return { status: 500, body: { error: exception.code, message: exception.message } };
    }
    if (exception instanceof HttpException) {
      // JSON malformado (400), corpo grande demais (413) e rota inexistente (404).
      const status = exception.getStatus();
      const error =
        status === 400
          ? 'INVALID_PAYLOAD'
          : status === 404
            ? 'NOT_FOUND'
            : status === 413
              ? 'PAYLOAD_TOO_LARGE'
              : 'HTTP_ERROR';
      return { status, body: { error, message: exception.message } };
    }
    if (isTransientDbError(exception)) {
      return {
        status: 503,
        body: {
          error: 'TRANSIENT_INFRASTRUCTURE_ERROR',
          message: 'Falha transitória; tente novamente',
        },
        retryAfter: 1,
      };
    }
    return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Erro interno inesperado' } };
  }
}
