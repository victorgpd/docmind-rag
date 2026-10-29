import { AgentRequestSchema } from '@docmind/agent';
import { conversations, desc, eq, messages } from '@docmind/db';
import { createReranker, type ChatMessage } from '@docmind/llm';
import { createRag, hasStaleEmbeddings, REINDEX_NEEDED, sharedCache } from '@docmind/retrieval';
import { SendMessageBody, type SseEvent } from '@docmind/shared';
import { Router } from 'express';
import type { z } from 'zod';
import type { Deps } from '../app';
import { authenticate, withOrg } from '../http/auth';
import { openSse } from '../http/sse';
import { validate } from '../http/validate';
import { assertWithinLimit, createAgentRunner, type AgentRunnerOpts } from './agent-run';
import { DEFAULT_TITLE, findOwnConversation, IdParams } from './conversations';
import { assertWithinGlobalLimit } from './usage';

const HISTORY = 10; // mensagens anteriores enviadas à reescrita/prompt

export function messagesRouter(deps: Deps, agentOpts: AgentRunnerOpts = {}) {
  const r = Router();
  const agentRunner = createAgentRunner(deps, agentOpts); // a mesma execução de POST /agent/run
  const rag = createRag({ scope: agentRunner.scope, llm: deps.llm, reranker: createReranker(), cache: sharedCache, rank: agentRunner.rank });

  /**
   * POST /conversations/:id/messages -> text/event-stream.
   * Chat: token*, citations, done | error. Com {agent:true}: os eventos de /agent/run (plan, step, step_result, result | error)
   * e, no fim, done com o messageId; a resposta (citações e payload da ferramenta, ex. tabela extraída) fica no histórico.
   */
  r.post('/conversations/:id/messages', authenticate, validate({ params: IdParams, body: SendMessageBody }), async (req, res) => {
    const { orgId, userId } = req.auth;
    const id = req.params.id as string;
    const { content: question, agent } = req.body as z.infer<typeof SendMessageBody>;
    const conv = await findOwnConversation(req, id);
    // pedido inválido para o agente (ex.: mais de 2000 caracteres) é 400 antes de persistir qualquer coisa
    const agentBody = agent ? AgentRequestSchema.parse({ query: question, ...(conv.collectionId ? { collectionId: conv.collectionId } : {}) }) : undefined;

    // tudo que pode falhar com status HTTP acontece antes de abrir o stream
    await assertWithinGlobalLimit(deps);
    const history = await withOrg(req, async (tx) => {
      await assertWithinLimit(tx, deps);
      const prev = await tx
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(desc(messages.createdAt))
        .limit(HISTORY);
      await tx.insert(messages).values({ organizationId: orgId, conversationId: id, role: 'user', content: question });
      if (conv.title === DEFAULT_TITLE) await tx.update(conversations).set({ title: question.slice(0, 60) }).where(eq(conversations.id, id));
      return prev.reverse() as ChatMessage[];
    });

    // chunks de outro modelo de embedding no escopo: a busca vetorial os ignora; avisa no `done` (chat e agente)
    const warnings = (await hasStaleEmbeddings(agentRunner.scope, { orgId, collectionId: conv.collectionId, embeddingModel: deps.llm.embeddingModel })) ? [REINDEX_NEEDED] : undefined;

    const s = openSse(res);
    // res 'close' (e não req 'close', que dispara ao fim da leitura do corpo) sinaliza a desconexão do cliente
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const saveAnswer = async (content: string, citations: unknown[], data: unknown = null) => {
      const [m] = await withOrg(req, (tx) =>
        tx.insert(messages).values({ organizationId: orgId, conversationId: id, role: 'assistant', content, citations, data }).returning({ id: messages.id }),
      );
      return m!.id;
    };
    const send = (e: SseEvent) => s.send(e.type, e);

    try {
      if (agentBody) {
        for await (const e of agentRunner.run(req, agentBody, abort.signal)) {
          if (s.closed) break; // cliente desconectou: para de gerar
          if (e.type !== 'result') {
            s.send(e.type, e); // plan, step, step_result, error: iguais aos de /agent/run
            continue;
          }
          const { answer, citations, data, intent, steps, truncated, usage } = e.result;
          const messageId = await saveAnswer(answer, citations, { intent, data, steps, truncated });
          s.send('result', e);
          send({ type: 'done', messageId, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, ...(warnings && { warnings }) });
        }
      } else {
        const input = { orgId, userId, collectionId: conv.collectionId, question, history, signal: abort.signal };
        for await (const e of rag.answer(input)) {
          if (s.closed) break;
          if (e.type !== 'result') {
            send(e);
            continue;
          }
          const messageId = await saveAnswer(e.content, e.citations);
          send({ type: 'citations', citations: e.citations });
          send({ type: 'done', messageId, tokensIn: e.tokensIn, tokensOut: e.tokensOut, ...(warnings && { warnings }) });
        }
      }
    } catch (err) {
      req.log.error({ err }, 'chat stream failed');
      send({ type: 'error', message: 'Falha ao gerar a resposta.' });
    }
    s.end();
  });

  return r;
}
