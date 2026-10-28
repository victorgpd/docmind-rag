import { collections, eq } from '@docmind/db';
import { Collection, CollectionList, CreateCollectionBody, UpdateCollectionBody } from '@docmind/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin, withOrg } from '../http/auth';
import { HttpError } from '../http/errors';
import { validate } from '../http/validate';

const toDto = (c: typeof collections.$inferSelect) => Collection.parse({ ...c, createdAt: c.createdAt.toISOString() });
const Params = z.object({ id: z.string().uuid() });

// RLS (withOrg) restringe todas as queries a organizacao do token; nao precisa filtrar por organization_id.
export function collectionsRouter() {
  const r = Router();

  const find = async (req: Request, id: string) => {
    const [c] = await withOrg(req, (tx) => tx.select().from(collections).where(eq(collections.id, id)));
    if (!c) throw new HttpError(404, 'not_found', 'Collection not found');
    return c;
  };

  r.get('/collections', authenticate, async (req, res) => {
    const rows = await withOrg(req, (tx) => tx.select().from(collections).orderBy(collections.createdAt));
    res.json(CollectionList.parse({ items: rows.map(toDto) }));
  });

  r.post('/collections', authenticate, validate({ body: CreateCollectionBody }), async (req, res) => {
    const b = CreateCollectionBody.parse(req.body);
    const [c] = await withOrg(req, (tx) => tx.insert(collections).values({ organizationId: req.auth.orgId, name: b.name, description: b.description }).returning());
    res.status(201).json(toDto(c!));
  });

  r.get('/collections/:id', authenticate, validate({ params: Params }), async (req, res) => {
    res.json(toDto(await find(req, req.params.id as string)));
  });

  r.patch('/collections/:id', requireAdmin, validate({ params: Params, body: UpdateCollectionBody }), async (req, res) => {
    const id = req.params.id as string;
    await find(req, id);
    const { name, description } = UpdateCollectionBody.parse(req.body);
    const set = { ...(name !== undefined && { name }), ...(description !== undefined && { description }) };
    if (!Object.keys(set).length) return void res.json(toDto(await find(req, id)));
    const [c] = await withOrg(req, (tx) => tx.update(collections).set(set).where(eq(collections.id, id)).returning());
    res.json(toDto(c!));
  });

  r.delete('/collections/:id', requireAdmin, validate({ params: Params }), async (req, res) => {
    const id = req.params.id as string;
    await find(req, id);
    // documentos e chunks saem por ON DELETE CASCADE; arquivos no storage ficam orfaos (limpeza pertence a rota de documentos)
    await withOrg(req, (tx) => tx.delete(collections).where(eq(collections.id, id)));
    res.status(204).end();
  });

  return r;
}
