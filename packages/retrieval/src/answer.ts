import { usageEvents, withOrg, type Db } from '@docmind/db';
import type { ChatMessage, LLMProvider, Reranker } from '@docmind/llm';
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
const cacheKey = (orgId: string, collectionId: string | null | undefined) => `${orgId}:${collectionId ?? '*'}`;

/** Cache compartilhado pelo processo: a API o passa ao createRag e o `invalidate` o esvazia. */
export const sharedCache = new SemanticCache<Cached>();

/**
 * Descarta respostas em cache de uma organização (ou só de uma coleção) quando seus documentos mudam:
 * ficou `ready` após reprocessar, foi excluído ou a coleção foi apagada. Com `collectionId`, também limpa
 * as respostas "sem coleção" da org, que podiam citar essa coleção.
 * shortcut: age só no cache deste processo; com worker em outro processo (REDIS_URL) vale o TTL de 10 min.
 */
export function invalidate(
  { organizationId, collectionId }: { organizationId: string; collectionId?: string | null },
  cache: SemanticCache<any> = sharedCache,
): number {
  const keys = new Set(collectionId ? [cacheKey(organizationId, collectionId), cacheKey(organizationId, null)] : []);
  clearStaleMemo(organizationId); // documento mudou: o aviso de reindexação precisa ser recalculado
  return cache.clear(collectionId ? (k) => keys.has(k) : (k) => k.startsWith(`${organizationId}:`));
}

export type RagDeps = { db: Db; llm: LLMProvider; reranker: Reranker; cache?: SemanticCache<Cached>; rank?: RankConfig };
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

const tokens = (s: string) => Math.ceil(s.length / 4); // estimativa; o provider local não informa uso

/** Pipeline RAG: reescrita -> cache -> busca híbrida (RRF) -> rerank -> prompt -> stream validado -> usage_events. */
export function createRag({ db, llm, reranker, cache = new SemanticCache<Cached>(), rank = DEFAULT_RANK }: RagDeps) {
  return {
    async *answer(input: AnswerInput): AsyncGenerator<AnswerEvent> {
      const t0 = Date.now();
      const { orgId, userId, collectionId } = input;
      const aborted = () => input.signal?.aborted === true;
      const record = (tokensIn: number, tokensOut: number) =>
        withOrg(db, orgId, (tx) =>
          tx.insert(usageEvents).values({ organizationId: orgId, userId, kind: 'query', tokensIn, tokensOut, latencyMs: Date.now() - t0 }),
        );
      const query = rewriteQuestion(input.question, input.history);
      const [embedding] = await llm.embed([query]);
      if (aborted()) return; // nada foi gasto além do embedding local: sem usage
      const key = cacheKey(orgId, collectionId);

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
        const ranked = await retrieve({ db, llm, reranker, rank }, { orgId, query, collectionId, embedding });
        // abstenção: o melhor trecho não é relevante o bastante para sustentar uma resposta
        const passages = ranked.relevance >= rank.minRelevance ? ranked.passages : [];
        if (aborted()) return;

        used = passages;
        if (!passages.length) {
          content = NO_ANSWER;
          yield { type: 'token', delta: content };
        } else {
          const messages = buildMessages(input.question, input.history, passages);
          const filter = new CitationFilter(passages.length);
          for await (const chunk of llm.generateStream(messages)) {
            if (aborted()) {
              // sai do for-await (encerra o gerador do provider); registra só o que foi realmente gerado.
              // Resposta parcial não é persistida nem cacheada: sem citações completas ela enganaria.
              await record(tokens(messages.map((m) => m.content).join('\n')), tokens(content));
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
          tokensIn = tokens(messages.map((m) => m.content).join('\n'));
          tokensOut = tokens(content);
          if (citations.length) cache.set(key, embedding!, { content, citations });
        }
      }

      await record(tokensIn, tokensOut);
      yield { type: 'result', content, citations, tokensIn, tokensOut, cached: !!hit, passages: used };
    },
  };
}
