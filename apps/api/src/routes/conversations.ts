import { and, collections, conversations, desc, eq, messages, orgScope } from '@docmind/db';
import { hasStaleEmbeddings, REINDEX_NEEDED } from '@docmind/retrieval';
import { CreateConversationBody, type Citation } from '@docmind/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Deps } from '../app';
import { authenticate, withOrg } from '../http/auth';
import { HttpError } from '../http/errors';
import { validate } from '../http/validate';

export const DEFAULT_TITLE = 'Nova conversa';
export const IdParams = z.object({ id: z.string().uuid() });

export const toConversation = (c: typeof conversations.$inferSelect) => ({ ...c, createdAt: c.createdAt.toISOString() });
export const toMessage = (m: typeof messages.$inferSelect) => ({
  ...m,
  citations: m.citations as Citation[],
  createdAt: m.createdAt.toISOString(),
});

/** Conversa do usuário autenticado (histórico é por usuário); 404 se não existir ou for de outro. */
export async function findOwnConversation(req: Request, id: string) {
  const [c] = await withOrg(req, (tx) =>
    tx.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, req.auth.userId))),
  );
  if (!c) throw new HttpError(404, 'not_found', 'Conversation not found');
  return c;
}

// RLS (withOrg) restringe à organização do token; o filtro por userId isola o histórico entre usuários da mesma org.
export function conversationsRouter(deps: Deps) {
  const r = Router();

  r.post('/conversations', authenticate, validate({ body: CreateConversationBody }), async (req, res) => {
    const { collectionId, title } = req.body as z.infer<typeof CreateConversationBody>;
    const row = await withOrg(req, async (tx) => {
      if (collectionId) {
        const [col] = await tx.select({ id: collections.id }).from(collections).where(eq(collections.id, collectionId));
        if (!col) throw new HttpError(404, 'not_found', 'Collection not found');
      }
      const [c] = await tx
        .insert(conversations)
        .values({ organizationId: req.auth.orgId, userId: req.auth.userId, collectionId, title: title?.trim() || DEFAULT_TITLE })
        .returning();
      return c!;
    });
    res.status(201).json(toConversation(row));
  });

  r.get('/conversations', authenticate, async (req, res) => {
    const rows = await withOrg(req, (tx) =>
      tx.select().from(conversations).where(eq(conversations.userId, req.auth.userId)).orderBy(desc(conversations.createdAt)),
    );
    res.json({ items: rows.map(toConversation) });
  });

  r.get('/conversations/:id', authenticate, validate({ params: IdParams }), async (req, res) => {
    const c = await findOwnConversation(req, req.params.id as string);
    const rows = await withOrg(req, (tx) => tx.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(messages.createdAt));
    // a coleção (ou a org, sem coleção) tem chunks de outro modelo de embedding? Memo de 60 s, limpo quando um documento muda
    const stale = await hasStaleEmbeddings(orgScope(deps.db.db), { orgId: req.auth.orgId, collectionId: c.collectionId, embeddingModel: deps.llm.embeddingModel });
    res.json({ ...toConversation(c), messages: rows.map(toMessage), ...(stale && { warnings: [REINDEX_NEEDED] }) });
  });

  return r;
}
