import type { Express } from 'express';
import { API_PREFIX } from '@docmind/shared';
import type { Deps } from '../app';
import { demoReadOnly } from '../http/demo';
import { agentRouter } from './agent';
import { authRouter } from './auth';
import { collectionsRouter } from './collections';
import { conversationsRouter } from './conversations';
import { documentsRouter } from './documents';
import { feedbackRouter } from './feedback';
import { messagesRouter } from './messages';
import { openapiRouter } from './openapi';
import { organizationRouter } from './organizations';
import { usageRouter } from './usage';

/**
 * Registro dos Routers. Cada dominio: `routes/<nome>.ts` exporta `<nome>Router(deps): Router`
 * (paths relativos a /api/v1, ex.: router.get('/documents', ...)). Adicione UMA linha aqui.
 */
export function mountRoutes(app: Express, deps: Deps) {
  const v1 = (r: import('express').Router) => app.use(API_PREFIX, r);
  void deps;
  void v1;
  app.use(API_PREFIX, demoReadOnly); // antes das rotas: conta de demonstracao somente leitura
  v1(openapiRouter());
  v1(authRouter(deps));
  v1(organizationRouter());
  v1(collectionsRouter());
  v1(usageRouter(deps));
  v1(agentRouter(deps));
  v1(conversationsRouter(deps));
  v1(messagesRouter(deps));
  v1(feedbackRouter());
  v1(documentsRouter(deps));
}
