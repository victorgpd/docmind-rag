# API em Express: convenção

A API (`apps/api`) é **Express 5 + TypeScript** (não Fastify). Contratos HTTP e schemas de `packages/shared` não mudam.
Esqueleto pronto em `apps/api/src`. Teste: `pnpm --filter @docmind/api test`.

## Estrutura
```
src/main.ts            boot (loadConfig, createDb, buildApp, app.listen)
src/app.ts             buildApp(deps) -> Express app; export type Deps
src/http/errors.ts     HttpError(status, code, msg), errorHandler, notFound
src/http/validate.ts   validate({ body?, query?, params? })  (Zod)
src/http/auth.ts       identify (global), authenticate, requireAdmin, withOrg(req, fn), signAccess
src/http/sse.ts        openSse(res) -> { send(event, data), end(), closed }
src/http/upload.ts     upload(maxBytes) = multer em memória: upload(n).single('file') -> req.file.buffer
src/http/middleware.ts requestContext (req.id/req.log/latência), rateLimit(limiter, rules, scope)
src/routes/index.ts    mountRoutes: UMA linha por Router
src/routes/<dominio>.ts  export function <dominio>Router(deps): Router
```

## Como criar uma rota
```ts
import { Router } from 'express';
import { z } from 'zod';
import { CreateCollectionBody, Collection } from '@docmind/shared';
import type { Deps } from '../app';
import { authenticate, requireAdmin, withOrg } from '../http/auth';
import { HttpError } from '../http/errors';
import { validate } from '../http/validate';

export function collectionsRouter(_deps: Deps) {
  const r = Router(); // paths relativos a /api/v1
  r.post('/collections', authenticate, validate({ body: CreateCollectionBody }), async (req, res) => {
    const body = req.body as z.infer<typeof CreateCollectionBody>;
    const rows = await withOrg(req, (tx) => tx.insert(collections).values({ organizationId: req.auth.orgId, ...body }).returning());
    res.status(201).json(toDto(rows[0]!));
  });
  return r;
}
```
Em `routes/index.ts`: `v1(collectionsRouter(deps));`

## Regras
- **Async solto**: Express 5 repassa rejeições de handlers async ao errorHandler. Não use try/catch só para isso; **lance `HttpError`**.
- **Erro** sempre `{ error: { code, message } }` (`ApiError` de shared). 400 = Zod (`validation_error`), 401/403/404/409 via `HttpError`.
- **Auth**: header `Authorization: Bearer <access JWT>`. `identify` (global) preenche `req.auth = { userId, orgId, role }` sem rejeitar; `authenticate` exige; `requireAdmin` exige papel admin (ou owner). Refresh token é cookie httpOnly `refresh_token` (path `/api/v1/auth`).
- **RLS**: toda query de dados de tenant dentro de `withOrg(req, tx => ...)`. A conexão crua `req.app.locals.deps.db.db` só para auth/login/worker.
- **Validação**: `validate({ body, query, params })` troca `req.body/params/query` pelo valor parseado; tipar no handler com `z.infer`.
- **SSE**: `const s = openSse(res); s.send('token', { type:'token', delta })`; formato `event: <type>\ndata: <json>\n\n`; pare se `s.closed`; sempre `s.end()`. Escute `req.on('close')` para abortar geração.
- **Upload**: `upload(MAX).single('file')`; tipo de arquivo validado por magic bytes no handler (`@docmind/security`). Excesso de tamanho = erro 413 do multer.
- **Rate limit**: `rateLimit(limiter, { user: {limit, windowMs}, org? }, 'escopo')` como middleware de rota ou de Router; `limiter = createRateLimiter(REDIS_URL)`.
- **Observabilidade** (`@docmind/observability`, montada em `app.ts`): `req.log` e `req.id` (pino-http, devolve `x-request-id`), `req.tracer.span(...)` e `req.metrics` (mesma instância de `app.locals.metrics`; latência `http` já medida). `GET /metrics` é do app e protegido (`METRICS_TOKEN` ou só loopback). Em `development` os spans vão para o console. Nunca logue senhas/tokens.
- **Config/deps** em `req.app.locals.deps` (mesmo objeto `Deps` recebido pelo Router).
- **Testes**: `import request from 'supertest'; const app = buildApp(deps); await request(app).post('/api/v1/...').set('Authorization', ...)`. Cookies: `.set('Cookie', 'refresh_token=...')`. Limites de `/auth` vêm de `loadConfig` (`AUTH_RATE_LIMIT`): use `AUTH_RATE_LIMIT: '1000'` nos testes que fazem muitos logins; cada `buildApp` tem seu próprio limiter em memória.
- **Erros de upload**: `MulterError` vira 413 `file_too_large` (limite de tamanho) ou 400 com o código do multer em minúsculas.

