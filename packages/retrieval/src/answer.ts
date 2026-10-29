import { documents, eq, sql, usageEvents, type OrgScope } from '@docmind/db';
import type { ChatMessage, LLMProvider, Reranker, Usage } from '@docmind/llm';
import type { Citation } from '@docmind/shared';
import { SemanticCache } from './cache';
import { buildCitations, CitationFilter, type Passage } from './citations';
import { buildMessages } from './prompt';
import { DEFAULT_RANK, type RankConfig } from './rank';
import { retrieve } from './retrieve';
import { clearStaleMemo } from './stale';
import { rewriteQuestion } from './rewrite';

export const NO_ANSWER = 'Não encontrei informação suficiente nos documentos.';

export type Cached = { content: string; citations: Citation[] };
// sem `version` vira o prefixo da coleção (o invalidate limpa todas as versões)
const cacheKey = (orgId: string, collectionId: string | null | undefined, version = '') => `${orgId}:${collectionId ?? '*'}:${version}`;

/**
 * Versão barata do índice no escopo (coleção, ou a org inteira), sob RLS: contagem + max(updated_at) dos documentos.
 * Entra na chave do cache: documento novo, reprocessado ou excluído muda a chave, mesmo que a mudança venha de outro processo.
 */
const indexVersion = (scope: OrgScope, orgId: string, collectionId: string | null) =>
  scope(orgId, async (tx) => {
    const [v] = await tx
      .select({ n: sql<number>`count(*)`, at: sql<string>`max(${documents.updatedAt})::text` })
      .from(documents)
      .where(collectionId ? eq(documents.collectionId, collectionId) : undefined);
    return `${v!.n}@${v!.at}`;
  });

/** Cache compartilhado pelo processo: a API o passa ao createRag e o `invalidate` o esvazia. */
export const sharedCache = new SemanticCache<Cached>();

/**
 * Descarta respostas em cache de uma organização (ou só de uma coleção) quando seus documentos mudam:
 * ficou `ready` após reprocessar, foi excluído ou a coleção foi apagada. Com `collectionId`, também limpa
 * as respostas "sem coleção" da org, que podiam citar essa coleção.
 * Age só neste processo. Com o worker em outro processo (REDIS_URL) quem protege é a versão na chave (indexVersion);
 * aqui só se libera memória e o aviso de reindexação (memo de 60 s, por processo).
 */
export function invalidate(
  { organizationId, collectionId }: { organizationId: string; collectionId?: string | null },
  cache: SemanticCache<any> = sharedCache,
): number {
  const prefixes = collectionId ? [cacheKey(organizationId, collectionId), cacheKey(organizationId, null)] : [`${organizationId}:`];
  clearStaleMemo(organizationId); // documento mudou: o aviso de reindexação precisa ser recalculado
  return cache.clear((k) => prefixes.some((p) => k.startsWith(p)));
}

export type RagDeps = { scope: OrgScope; llm: LLMProvider; reranker: Reranker; cache?: SemanticCache<Cached>; rank?: RankConfig };
export type AnswerInput = {
  orgId: string;
  userId: string;
  collectionId: string | null;
  question: string;
  history: ChatMessage[];
  /** Cliente desconectou: para de recuperar/gerar, não cacheia e não emite `result`. */
  signal?: AbortSignal;
};
export type AnswerEvent =
  | { type: 'token'; delta: string }
  | {
      type: 'result';
      content: string;
      citations: Citation[];
      tokensIn: number;
      tokensOut: number;
      cached: boolean;
      /** Lista única que vira o prompt, o filtro de [n] e as citações: `passages[n - 1]` é a fonte do marcador [n]. Vazia em cache/abstenção. */
      passages?: Passage[];
    };

const tokens = (s: string) => Math.ceil(s.length / 4); // estimativa só quando o provider não informa o uso real (local/ollama)

/** Pipeline RAG: reescrita -> cache -> busca híbrida (RRF) -> rerank -> prompt -> stream validado -> usage_events. */
export function createRag({ scope, llm, reranker, cache = new SemanticCache<Cached>(), rank = DEFAULT_RANK }: RagDeps) {
  return {
    async *answer(input: AnswerInput): AsyncGenerator<AnswerEvent> {
      const t0 = Date.now();
      const { orgId, userId, collectionId } = input;
      const aborted = () => input.signal?.aborted === true;
      const record = (tokensIn: number, tokensOut: number) =>
        scope(orgId, (tx) =>
          tx.insert(usageEvents).values({ organizationId: orgId, userId, kind: 'query', tokensIn, tokensOut, latencyMs: Date.now() - t0 }),
        );
      const query = rewriteQuestion(input.question, input.history);
      // embedding da consulta: só conta o que o provider informa (OpenAI); o local é grátis e não informa. Uma chamada só: o vetor segue para o cache e a busca.
      let embedIn = 0;
      const [embedding] = await llm.embed([query], { onUsage: (u) => (embedIn += u.inputTokens) });
      if (aborted()) {
        if (embedIn) await record(embedIn, 0);
        return;
      }
      const key = cacheKey(orgId, collectionId, await indexVersion(scope, orgId, collectionId));

      let content = '';
      let citations: Citation[] = [];
      let used: Passage[] = [];
      let tokensIn = 0;
      let tokensOut = 0;
      const hit = cache.get(key, embedding!);

      if (hit) {
        ({ content, citations } = hit);
        yield { type: 'token', delta: content };
      } else {
        const ranked = await retrieve({ scope, llm, reranker, rank }, { orgId, query, collectionId, embedding });
        // abstenção: o melhor trecho não é relevante o bastante para sustentar uma resposta
        const passages = ranked.relevance >= rank.minRelevance ? ranked.passages : [];
        if (aborted()) {
          if (embedIn) await record(embedIn, 0);
          return;
        }

        used = passages;
        if (!passages.length) {
          content = NO_ANSWER;
          yield { type: 'token', delta: content };
        } else {
          const messages = buildMessages(input.question, input.history, passages);
          const filter = new CitationFilter(passages.length);
          const real: { usage?: Usage } = {}; // tokens que o provider cobrou (OpenAI informa no fim do stream)
          const promptTokens = () => real.usage?.inputTokens ?? tokens(messages.map((m) => m.content).join('\n'));
          for await (const chunk of llm.generateStream(messages, { onUsage: (u) => (real.usage = u) })) {
            if (aborted()) {
              // sai do for-await (encerra o gerador do provider); registra só o que foi realmente gerado.
              // Resposta parcial não é persistida nem cacheada: sem citações completas ela enganaria.
              await record(embedIn + promptTokens(), real.usage?.outputTokens ?? tokens(content));
              return;
            }
            const delta = filter.push(chunk);
            if (delta) {
              content += delta;
              yield { type: 'token', delta };
            }
          }
          const tail = filter.flush();
          if (tail) {
            content += tail;
            yield { type: 'token', delta: tail };
          }
          citations = buildCitations(passages, filter.used);
          tokensIn = embedIn + promptTokens();
          tokensOut = real.usage?.outputTokens ?? tokens(content);
          if (citations.length) cache.set(key, embedding!, { content, citations });
        }
      }

      if (!tokensIn) tokensIn = embedIn; // cache e abstenção: só o embedding
      await record(tokensIn, tokensOut);
      yield { type: 'result', content, citations, tokensIn, tokensOut, cached: !!hit, passages: used };
    },
  };
}
