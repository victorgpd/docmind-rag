import { and, conversations, eq, feedback, messages } from '@docmind/db';
import { CreateFeedbackBody } from '@docmind/shared';
import { Router } from 'express';
import type { z } from 'zod';
import { authenticate, withOrg } from '../http/auth';
import { HttpError } from '../http/errors';
import { validate } from '../http/validate';
import { IdParams } from './conversations';

/** POST /messages/:id/feedback — 1 avaliação por (mensagem, usuário); reenviar atualiza. */
export function feedbackRouter() {
  const r = Router();

  r.post('/messages/:id/feedback', authenticate, validate({ params: IdParams, body: CreateFeedbackBody }), async (req, res) => {
    const { orgId, userId } = req.auth;
    const { rating, comment } = req.body as z.infer<typeof CreateFeedbackBody>;
    const row = await withOrg(req, async (tx) => {
      const [own] = await tx
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(eq(messages.id, req.params.id as string), eq(conversations.userId, userId)));
      if (!own) throw new HttpError(404, 'not_found', 'Message not found');

      const [prev] = await tx.select({ id: feedback.id }).from(feedback).where(and(eq(feedback.messageId, own.id), eq(feedback.userId, userId)));
      const [saved] = prev
        ? await tx.update(feedback).set({ rating, comment: comment ?? null }).where(eq(feedback.id, prev.id)).returning()
        : await tx.insert(feedback).values({ organizationId: orgId, messageId: own.id, userId, rating, comment }).returning();
      return saved!;
    });
    res.json({ ...row, createdAt: row.createdAt.toISOString() });
  });

  return r;
}
