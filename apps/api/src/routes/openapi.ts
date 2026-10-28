import { Router } from 'express';
import { buildOpenApi } from '@docmind/shared/openapi';

/** GET /api/v1/openapi.json (montar em /api/v1; público). Documento gerado uma vez dos schemas Zod. */
export function openapiRouter(): Router {
  const doc = buildOpenApi();
  return Router().get('/openapi.json', (_req, res) => res.json(doc));
}
