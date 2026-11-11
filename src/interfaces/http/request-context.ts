import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RequestWithContext extends Request {
  correlationId: string;
}

/**
 * Todo request ganha um correlationId: o que o cliente mandou (se for válido) ou um novo.
 * Ele vai para os logs, para os eventos da outbox e volta no header da resposta,
 * ligando "a chamada do provedor" a "o evento publicado" a "a linha de log".
 */
export function correlationIdMiddleware(newId: () => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && VALID_CORRELATION_ID.test(incoming) ? incoming : newId();
    (req as RequestWithContext).correlationId = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);
    next();
  };
}
