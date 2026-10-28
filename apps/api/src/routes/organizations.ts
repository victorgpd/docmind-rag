import { hash } from '@node-rs/argon2';
import { eq, memberships, organizations, users } from '@docmind/db';
import { AddMemberBody, MemberList, OrganizationDetail, UpdateMemberBody } from '@docmind/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, isAdmin, requireAdmin, withOrg } from '../http/auth';
import { HttpError } from '../http/errors';
import { validate } from '../http/validate';
import { isUniqueViolation } from './auth';

const Params = z.object({ userId: z.string().uuid() });

export function organizationRouter() {
  const r = Router();

  r.get('/organization', authenticate, async (req, res) => {
    const [org] = await withOrg(req, (tx) => tx.select().from(organizations));
    if (!org) throw new HttpError(404, 'not_found', 'Organization not found');
    res.json(OrganizationDetail.parse({ id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt.toISOString(), role: req.auth.role }));
  });

  r.get('/organization/members', authenticate, async (req, res) => {
    const rows = await withOrg(req, (tx) =>
      tx
        .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId)),
    );
    res.json(MemberList.parse({ items: rows }));
  });

  r.post('/organization/members', requireAdmin, validate({ body: AddMemberBody }), async (req, res) => {
    const b = AddMemberBody.parse(req.body);
    const passwordHash = await hash(b.password);
    try {
      const m = await withOrg(req, async (tx) => {
        const [u] = await tx.insert(users).values({ organizationId: req.auth.orgId, email: b.email.toLowerCase(), name: b.name, passwordHash }).returning();
        await tx.insert(memberships).values({ organizationId: req.auth.orgId, userId: u!.id, role: b.role });
        return { userId: u!.id, email: u!.email, name: u!.name, role: b.role };
      });
      res.status(201).json(m);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'email_taken', 'Email already registered');
      throw e;
    }
  });

  r.patch('/organization/members/:userId', requireAdmin, validate({ params: Params, body: UpdateMemberBody }), async (req, res) => {
    const { userId } = Params.parse(req.params);
    const { role } = UpdateMemberBody.parse(req.body);
    await withOrg(req, async (tx) => {
      const rows = await tx.select().from(memberships);
      const target = rows.find((m) => m.userId === userId);
      if (!target) throw new HttpError(404, 'not_found', 'Member not found');
      // impede ficar sem admin: ninguem mais conseguiria gerenciar a organizacao
      if (isAdmin(target.role) && role === 'member' && rows.filter((m) => isAdmin(m.role)).length === 1)
        throw new HttpError(409, 'last_admin', 'Organization must keep at least one admin');
      await tx.update(memberships).set({ role }).where(eq(memberships.id, target.id));
    });
    res.json({ userId, role });
  });

  return r;
}
