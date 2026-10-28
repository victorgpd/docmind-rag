import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, memberships, organizations, refreshTokens, sql, users } from '@docmind/db';
import { DemoStatus, LoginBody, OrganizationList, RegisterBody, SwitchOrgBody } from '@docmind/shared';
import { Router, type Request, type Response } from 'express';
import type { Deps } from '../app';
import { signAccess, authenticate } from '../http/auth';
import { findDemoUser } from '../http/demo';
import { HttpError } from '../http/errors';
import { rateLimitBy } from '../http/middleware';
import { validate } from '../http/validate';

const COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/v1/auth';
const REFRESH_TTL_MS = 7 * 24 * 3600 * 1000;
// Duas abas renovando juntas apresentam o mesmo token: nesta janela o antigo devolve o mesmo sucessor em vez de contar como reuso.
const GRACE_MS = 10_000;

// hash de mentira para igualar o tempo de resposta quando o email nao existe
const dummyHash = hash('dummy-password1');

export const isUniqueViolation = (e: any) => (e?.code ?? e?.cause?.code) === '23505';
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'org';

type UserRow = typeof users.$inferSelect;

/** Remove refresh tokens expirados (revogados ou nao ficam ate expirar para manter a deteccao de reuso). */
export const purgeExpiredRefreshTokens = (db: Deps['db']['db']) => db.delete(refreshTokens).where(sql`${refreshTokens.expiresAt} < now()`);

export function authRouter(deps: Deps) {
  const r = Router();
  const db = deps.db.db; // conexao crua: auth roda antes de existir orgId e refresh_tokens nao tem RLS
  const secure = deps.config.NODE_ENV === 'production';
  const limiter = (req: Request) => req.app.locals.limiter;

  const max = () => deps.config.AUTH_RATE_LIMIT;
  const byIp = (scope: string, limit: () => number) => (req: Request, res: Response, next: (e?: unknown) => void) =>
    rateLimitBy(limiter(req), scope, { limit: limit(), windowMs: 60_000 }, (q) => `ip:${q.ip}`)(req, res, next);
  const byEmail = (req: Request, res: Response, next: (e?: unknown) => void) =>
    rateLimitBy(limiter(req), 'auth-email', { limit: Math.ceil(max() / 2), windowMs: 60_000 }, (q) =>
      // IP+e-mail: quem erra de outro IP nao trava o login da vitima (o limite por IP ja cobre varredura de e-mails)
      typeof q.body?.email === 'string' ? `email:${q.ip}:${q.body.email.toLowerCase()}` : undefined,
    )(req, res, next);

  // Cada cadastro cria uma organizacao (com limite de tokens proprio): fechar o cadastro e limitar por IP/dia freia contas em serie.
  const registrationOpen = (_req: Request, _res: Response, next: (e?: unknown) => void) =>
    next(deps.config.REGISTRATION_ENABLED ? undefined : new HttpError(403, 'registration_closed', 'Cadastro fechado no momento.'));
  const perDay = deps.config.REGISTRATION_LIMIT_PER_IP_PER_DAY ?? (deps.config.NODE_ENV === 'test' ? 0 : 5);
  const registrationsPerIp = (req: Request, res: Response, next: (e?: unknown) => void) =>
    perDay
      ? rateLimitBy(limiter(req), 'register-ip-day', { limit: perDay, windowMs: 86_400_000 }, (q) => `ip:${q.ip}`, (s) =>
          `Limite de cadastros deste endereço atingido hoje. Tente novamente em ${Math.ceil(s / 3600)} h.`,
        )(req, res, next)
      : next();

  const setCookie = (res: Response, token: string) =>
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: COOKIE_PATH, maxAge: REFRESH_TTL_MS });
  const clearCookie = (res: Response) => res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: COOKIE_PATH });

  const newToken = () => randomBytes(32).toString('base64url');
  // Sucessor deterministico (HMAC do id do antecessor): permite reentregar o mesmo token na janela de tolerancia sem guardar o texto puro.
  const successorOf = (rowId: string) => createHmac('sha256', deps.config.JWT_SECRET).update(`refresh-successor:${rowId}`).digest('base64url');
  const insertRefresh = (tx: typeof db, v: { userId: string; orgId: string; familyId: string; token: string }) =>
    tx
      .insert(refreshTokens)
      .values({ organizationId: v.orgId, userId: v.userId, familyId: v.familyId, tokenHash: sha256(v.token), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) })
      .returning({ id: refreshTokens.id });

  const revokeFamily = (familyId: string) =>
    db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, familyId), sql`${refreshTokens.revokedAt} is null`));

  /** Abre uma sessao nova (familia nova): access JWT + refresh opaco em cookie. */
  const startSession = async (res: Response, user: UserRow, orgId: string, role: string) => {
    const token = newToken();
    await insertRefresh(db, { userId: user.id, orgId, familyId: randomUUID(), token });
    setCookie(res, token);
    return body(user, orgId, role);
  };
  const demoEmail = deps.config.DEMO_LOGIN_ENABLED ? deps.config.DEMO_USER_EMAIL : undefined;
  const body = (user: UserRow, orgId: string, role: string) => ({
    token: signAccess(deps.config.JWT_SECRET, { userId: user.id, orgId, role }),
    user: { id: user.id, organizationId: orgId, email: user.email, name: user.name, createdAt: user.createdAt.toISOString() },
    ...(user.email === demoEmail && { demo: true }),
  });

  const membershipOf = async (userId: string, orgId: string) =>
    (
      await db
        .select({ user: users, role: memberships.role })
        .from(users)
        .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.organizationId, orgId)))
        .where(eq(users.id, userId))
    )[0];

  // o limite diario conta so pedidos validos (depois do validate): erro de digitacao nao gasta a cota
  r.post('/auth/register', registrationOpen, byIp('auth-ip', max), validate({ body: RegisterBody }), byEmail, registrationsPerIp, async (req, res) => {
    const b = RegisterBody.parse(req.body);
    const passwordHash = await hash(b.password);
    try {
      const user = await db.transaction(async (tx) => {
        const [org] = await tx
          .insert(organizations)
          .values({ name: b.organizationName, slug: `${slugify(b.organizationName)}-${randomUUID().slice(0, 6)}` })
          .returning();
        const [u] = await tx.insert(users).values({ organizationId: org!.id, email: b.email.toLowerCase(), name: b.name, passwordHash }).returning();
        await tx.insert(memberships).values({ organizationId: org!.id, userId: u!.id, role: 'admin' });
        return u!;
      });
      res.status(201).json(await startSession(res, user, user.organizationId, 'admin'));
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'email_taken', 'Email already registered');
      throw e;
    }
  });

  r.post('/auth/login', byIp('auth-ip', max), validate({ body: LoginBody }), byEmail, async (req, res) => {
    const b = LoginBody.parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.email, b.email.toLowerCase()));
    const ok = await verify(u?.passwordHash ?? (await dummyHash), b.password).catch(() => false);
    const m = u && ok ? await membershipOf(u.id, u.organizationId) : undefined;
    if (!u || !ok || !m) throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
    res.json(await startSession(res, u, u.organizationId, m.role));
  });

  // Conta de demonstracao: entra sem senha com a sessao normal (mesmo cookie do login); as escritas sao barradas em http/demo.ts.
  r.get('/auth/demo', async (req, res) => res.json(DemoStatus.parse({ enabled: !!(await findDemoUser(req)) })));
  const demoOn = (_req: Request, _res: Response, next: (e?: unknown) => void) => next(demoEmail ? undefined : new HttpError(404, 'not_found', 'Route not found'));
  const demoPerIp = (req: Request, res: Response, next: (e?: unknown) => void) =>
    rateLimitBy(limiter(req), 'auth-demo-ip', { limit: 20, windowMs: 3_600_000 }, (q) => `ip:${q.ip}`, (s) =>
      `Muitas entradas na demonstração a partir deste endereço. Tente novamente em ${Math.ceil(s / 60)} min.`,
    )(req, res, next);
  r.post('/auth/demo', demoOn, demoPerIp, async (req, res) => {
    const u = await findDemoUser(req);
    const m = u && (await membershipOf(u.id, u.organizationId));
    if (!u || !m) throw new HttpError(503, 'demo_unavailable', 'A demonstração não está disponível no momento.');
    res.json(await startSession(res, u, u.organizationId, m.role));
  });

  // Rotacao: cada refresh invalida o token apresentado e emite outro na mesma familia.
  // Reuso de um token ja rotacionado => alguem o copiou => revoga a familia inteira.
  r.post('/auth/refresh', byIp('auth-refresh-ip', () => max() * 3), async (req, res) => {
    const token = req.cookies?.[COOKIE];
    const deny = async (code: string, message: string, familyId?: string): Promise<never> => {
      if (familyId) await revokeFamily(familyId);
      clearCookie(res);
      throw new HttpError(401, code, message);
    };
    if (!token) return deny('unauthorized', 'Missing refresh token');
    const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token)));
    if (!row) return deny('unauthorized', 'Invalid refresh token');
    if (row.expiresAt.getTime() <= Date.now() && !row.revokedAt) return deny('unauthorized', 'Refresh token expired');

    const m = await membershipOf(row.userId, row.organizationId);
    if (!m) return deny('unauthorized', 'Membership no longer exists', row.familyId);
    const ok = () => body(m.user, row.organizationId, m.role);

    // Reapresentado dentro da janela e com sucessor ainda valido: devolve o mesmo sucessor.
    const regrant = async (r: typeof row) => {
      if (!r.replacedBy || Date.now() - (r.revokedAt?.getTime() ?? 0) > GRACE_MS) return false;
      const succ = successorOf(r.id);
      const [s] = await db.select().from(refreshTokens).where(and(eq(refreshTokens.tokenHash, sha256(succ)), sql`${refreshTokens.revokedAt} is null`));
      if (!s) return false;
      setCookie(res, succ);
      res.json(ok());
      return true;
    };
    if (row.revokedAt) {
      if (await regrant(row)) return;
      return deny('refresh_reuse', 'Refresh token already used', row.replacedBy ? row.familyId : undefined);
    }

    const next = successorOf(row.id);
    const rotated = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.id, row.id), sql`${refreshTokens.revokedAt} is null`))
        .returning({ id: refreshTokens.id });
      if (!claimed.length) return false; // corrida: outra requisicao rotacionou este token primeiro
      const [n] = await insertRefresh(tx as typeof db, { userId: row.userId, orgId: row.organizationId, familyId: row.familyId, token: next });
      await tx.update(refreshTokens).set({ replacedBy: n!.id }).where(eq(refreshTokens.id, row.id));
      return true;
    });
    if (!rotated) {
      const [fresh] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, row.id));
      if (fresh && (await regrant(fresh))) return;
      return deny('refresh_reuse', 'Refresh token already used', row.familyId);
    }
    setCookie(res, next);
    res.json(ok());
  });

  r.post('/auth/logout', async (req, res) => {
    const token = req.cookies?.[COOKIE];
    if (token) {
      const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(token)));
      if (row) await revokeFamily(row.familyId);
    }
    clearCookie(res);
    res.status(204).end();
  });

  // Troca a organizacao ativa (o usuario precisa ter membership nela): encerra a sessao atual e abre outra.
  r.post('/auth/switch-org', authenticate, validate({ body: SwitchOrgBody }), async (req, res) => {
    const { organizationId } = SwitchOrgBody.parse(req.body);
    const m = await membershipOf(req.auth.userId, organizationId);
    if (!m) throw new HttpError(403, 'forbidden', 'Not a member of that organization');
    const old = req.cookies?.[COOKIE];
    if (old) {
      const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(old)));
      if (row) await revokeFamily(row.familyId);
    }
    res.json(await startSession(res, m.user, organizationId, m.role));
  });

  r.get('/organizations', authenticate, async (req, res) => {
    const rows = await db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, createdAt: organizations.createdAt, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
      .where(eq(memberships.userId, req.auth.userId));
    res.json(OrganizationList.parse({ items: rows.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })) }));
  });

  return r;
}
