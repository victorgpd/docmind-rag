import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';

/** Erro de dominio com status HTTP; o errorHandler o converte em { error: { code, message } }. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, _res, next) => next(new HttpError(404, 'not_found', 'Route not found'));

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- o Express reconhece o handler de erro pela aridade (4 parametros)
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return void res.end();
  if (err instanceof HttpError) return void res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err instanceof ZodError) return void res.status(400).json({ error: { code: 'validation_error', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return void res.status(tooBig ? 413 : 400).json({ error: { code: tooBig ? 'file_too_large' : err.code.toLowerCase(), message: err.message } });
  }
  const status = typeof err?.status === 'number' && err.status < 500 ? err.status : 500; // ex.: JSON invalido do body-parser (400)
  if (status === 500) req.log?.error({ err }, 'unhandled error');
  res.status(status).json({ error: { code: status === 500 ? 'internal_error' : (err.code ?? 'bad_request'), message: status === 500 ? 'Internal server error' : err.message } });
};
