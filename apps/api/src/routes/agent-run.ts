import { runAgent, type AgentEvent, type AgentRequestSchema, type ChunkReader, type Retriever } from '@docmind/agent';
import { usageEvents, type Db } from '@docmind/db';
import { createReranker } from '@docmind/llm';
import { createChunkReader, createRetriever, rankConfigFromEnv } from '@docmind/retrieval';
import type { Request } from 'express';
import type { z } from 'zod';
import type { Deps } from '../app';
import { withOrg } from '../http/auth';
import { HttpError } from '../http/errors';
import { getUsage } from './usage';

export type AgentRunnerOpts = {
  /** Sobrescreve busca/leitura de chunks (testes). Padrao: adaptadores de @docmind/retrieval. */
  retriever?: Retriever;
  chunks?: ChunkReader;
  maxSteps?: number;
};
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

/** 402 quando o limite mensal de tokens da organizacao foi excedido. Chat e agente usam esta mesma checagem. */
export async function assertWithinLimit(tx: Db, deps: Deps) {
  if ((await getUsage(tx, undefined, deps.config)).limitExceeded) throw new HttpError(402, 'usage_limit_exceeded', 'Monthly token limit exceeded');
}

/**
 * Unica execucao do agente para `POST /agent/run` e `POST /conversations/:id/messages` com {agent:true}: mesmos
 * adaptadores de busca, mesmo limiar de abstencao (RAG_MIN_RELEVANCE) e 1 usage_event (kind 'query') por execucao.
 * Para ao ver `signal` abortado (cliente desconectou); o uso do resultado ja gerado e registrado mesmo assim.
 */
export function createAgentRunner(deps: Deps, opts: AgentRunnerOpts = {}) {
  const rank = rankConfigFromEnv(deps.config);
  const retriever = opts.retriever ?? createRetriever({ db: deps.db.db, llm: deps.llm, reranker: createReranker(), rank });
  const chunks = opts.chunks ?? createChunkReader({ db: deps.db.db });

  return {
    rank,
    async *run(req: Request, body: AgentRequest, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      const { orgId, userId } = req.auth;
      const events = runAgent(body, { orgId, llm: deps.llm, retriever, chunks, maxSteps: opts.maxSteps, minRelevance: rank.minRelevance });
      for await (const e of events) {
        if (e.type === 'result') {
          const u = e.result.usage;
          await withOrg(req, (tx) =>
            tx.insert(usageEvents).values({ organizationId: orgId, userId, kind: 'query', tokensIn: u.tokensIn, tokensOut: u.tokensOut, latencyMs: u.latencyMs }),
          );
        }
        if (signal?.aborted) return; // cliente desconectou: nao executa mais passos
        yield e;
      }
    },
  };
}
