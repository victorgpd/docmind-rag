import { runAgent, type AgentEvent, type AgentRequestSchema, type ChunkReader, type Retriever } from '@docmind/agent';
import { orgScope, usageEvents, type Db } from '@docmind/db';
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
  const scope = orgScope(deps.db.db); // busca e leitor de chunks so recebem transacoes com RLS, nunca a conexao privilegiada
  const retriever = opts.retriever ?? createRetriever({ scope, llm: deps.llm, reranker: createReranker(), rank });
  const chunks = opts.chunks ?? createChunkReader({ scope });

  return {
    rank,
    scope,
    async *run(req: Request, body: AgentRequest, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      const { orgId, userId } = req.auth;
      const spent = { in: 0, out: 0 };
      const t0 = Date.now();
      const record = (tokensIn: number, tokensOut: number, latencyMs: number) =>
        withOrg(req, (tx) => tx.insert(usageEvents).values({ organizationId: orgId, userId, kind: 'query', tokensIn, tokensOut, latencyMs }));
      let recorded = false;
      try {
        const events = runAgent(body, { orgId, llm: deps.llm, retriever, chunks, maxSteps: opts.maxSteps, minRelevance: rank.minRelevance, usage: spent });
        for await (const e of events) {
          if (e.type === 'result') {
            const u = e.result.usage;
            recorded = true;
            await record(u.tokensIn, u.tokensOut, u.latencyMs);
          }
          if (signal?.aborted) return; // cliente desconectou: nao executa mais passos
          yield e;
        }
      } finally {
        // erro ou desconexão antes do resultado: o que o provider já cobrou conta no teto
        if (!recorded && spent.in + spent.out > 0) await record(spent.in, spent.out, Date.now() - t0);
      }
    },
  };
}
