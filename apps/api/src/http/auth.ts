import jwt from 'jsonwebtoken';
import { withOrg as dbWithOrg, type Db } from '@docmind/db';
import type { Request, RequestHandler } from 'express';
import { HttpError } from './errors';

export type AuthContext = { userId: string; orgId: string; role: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- ampliar Request do Express exige o namespace global
  namespace Express {
    interface Request {
      auth: AuthContext;
      id: string;
      log: import('pino').Logger;
    }
  }
}

export const ACCESS_TTL_SECONDS = 15 * 60;
export const isAdmin = (role: string) => role === 'admin' || role === 'owner';

const JWT_OPTS = { issuer: 'docmind', audience: 'docmind-api' } as const;

export const signAccess = (secret: string, c: AuthContext) => jwt.sign(c, secret, { ...JWT_OPTS, algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS });

/** Global: preenche req.auth se houver Bearer valido, sem rejeitar (para rate limit e logs ja enxergarem o usuario). */
export const identify: RequestHandler = (req, _res, next) => {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(h.slice(7), req.app.locals.jwtSecret, { ...JWT_OPTS, algorithms: ['HS256'] }) as AuthContext;
      req.auth = { userId: p.userId, orgId: p.orgId, role: p.role };
    } catch {
      /* invalido: authenticate responde 401 nas rotas protegidas */
    }
  }
  next();
};

export const authenticate: RequestHandler = (req, _res, next) =>
  next(req.auth ? undefined : new HttpError(401, 'unauthorized', 'Missing or invalid bearer token'));

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(new HttpError(401, 'unauthorized', 'Missing or invalid bearer token'));
  next(isAdmin(req.auth.role) ? undefined : new HttpError(403, 'forbidden', 'Admin role required'));
};

/** Executa fn numa transacao com RLS da organizacao autenticada. TODA query de dados de tenant passa por aqui. */
export const withOrg = <T>(req: Request, fn: (tx: Db) => Promise<T>): Promise<T> =>
  dbWithOrg(req.app.locals.deps.db.db, req.auth.orgId, fn);
