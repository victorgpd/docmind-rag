import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

/** Valida (e substitui por) body, query e params com Zod. Falha => ZodError => 400 pelo errorHandler. */
export const validate =
  (s: { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny }): RequestHandler =>
  (req, _res, next) => {
    if (s.body) req.body = s.body.parse(req.body ?? {});
    if (s.params) req.params = s.params.parse(req.params) as typeof req.params;
    // req.query e getter no Express 5: redefine como propriedade propria
    if (s.query) Object.defineProperty(req, 'query', { value: s.query.parse(req.query), configurable: true, enumerable: true });
    next();
  };
