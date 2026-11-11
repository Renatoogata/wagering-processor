import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { AppLogger } from '../../application/ports/observability';
import { mapError } from './error-mapping';
import type { RequestWithContext } from './request-context';

/**
 * Ponto ÚNICO onde erro vira resposta HTTP. Os controllers não têm try/catch:
 * isso garante que todos os endpoints usem o mesmo mapeamento (seção 9).
 *
 * Corpo de erro: { error: { code, message, retryable }, correlationId }
 * O provedor decide pelo STATUS e pelo `code`, nunca pela mensagem.
 */
@Catch()
export class ApplicationExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithContext>();
    const res = http.getResponse<Response>();

    // erros do próprio Nest/Express (JSON malformado, rota inexistente)
    const mapping =
      exception instanceof HttpException
        ? {
            status: exception.getStatus(),
            code: exception.getStatus() === HttpStatus.NOT_FOUND ? 'ROUTE_NOT_FOUND' : 'INVALID_REQUEST',
            message: exception.message,
            retryable: false,
          }
        : mapError(exception);

    const fields = {
      correlationId: req.correlationId,
      method: req.method,
      path: req.path,
      status: mapping.status,
      code: mapping.code,
    };
    if (mapping.status >= 500) {
      this.logger.error('request failed', { ...fields, error: exception instanceof Error ? exception.message : String(exception) });
    } else {
      this.logger.warn('request rejected', fields);
    }

    if (mapping.status === HttpStatus.SERVICE_UNAVAILABLE) res.setHeader('Retry-After', '1');
    res.status(mapping.status).json({
      error: { code: mapping.code, message: mapping.message, retryable: mapping.retryable },
      correlationId: req.correlationId,
    });
  }
}
