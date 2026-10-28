import { and, eq, organizations, users } from '@docmind/db';
import type { Request, RequestHandler } from 'express';
import { HttpError } from './errors';

// Escritas que a conta de demonstracao PODE fazer (paths relativos a /api/v1): conversar, avaliar respostas e a propria sessao.
// Lista do que pode, nao do que nao pode: uma rota de escrita nova ja nasce bloqueada para a demo.
const ALLOWED = [
  /^\/conversations$/,
  /^\/conversations\/[^/]+\/messages$/,
  /^\/agent\/run$/,
  /^\/messages\/[^/]+\/feedback$/,
  /^\/auth\/(login|register|demo|refresh|logout)$/, // abrem/fecham sessao sem usar req.auth
];
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Organizacao propria da demo (criada por scripts/demo-maintenance.ts). */
export const DEMO_ORG_NAME = 'Demonstração';

/** E-mail da conta de demonstracao, ou undefined se DEMO_LOGIN_ENABLED=false. */
const demoEmail = (req: Request): string | undefined => {
  const c = req.app.locals.deps.config;
  return c.DEMO_LOGIN_ENABLED ? c.DEMO_USER_EMAIL : undefined;
};

/**
 * Usuario de demonstracao (conexao crua: busca fora de uma org). So conta se estiver na organizacao "Demonstração":
 * DEMO_USER_EMAIL apontado por engano para uma conta real nao vira login sem senha nela. Guarda o id em app.locals para o demoReadOnly.
 */
export async function findDemoUser(req: Request): Promise<typeof users.$inferSelect | undefined> {
  const email = demoEmail(req);
  if (!email) return undefined;
  const [row] = await req.app.locals.deps.db.db
    .select({ user: users })
    .from(users)
    .innerJoin(organizations, and(eq(organizations.id, users.organizationId), eq(organizations.name, DEMO_ORG_NAME)))
    .where(eq(users.email, email));
  req.app.locals.demoUserId = row?.user.id;
  return row?.user;
}

/** Montado em /api/v1 antes das rotas: a conta de demonstracao e somente leitura, salvo ALLOWED. Os demais usuarios passam direto. */
export const demoReadOnly: RequestHandler = async (req, _res, next) => {
  if (!req.auth || SAFE.has(req.method) || !demoEmail(req) || ALLOWED.some((re) => re.test(req.path))) return next();
  // shortcut: id memorizado por processo (POST /auth/demo o renova); com varias replicas da API, recriar o usuario demo exige reiniciar as outras
  const id: string | undefined = req.app.locals.demoUserId ?? (await findDemoUser(req))?.id;
  next(id && req.auth.userId === id ? new HttpError(403, 'demo_read_only', 'A conta de demonstração é somente leitura.') : undefined);
};
