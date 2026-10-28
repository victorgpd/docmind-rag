# DocMind - Arquitetura

Plataforma RAG multi-tenant. 100% local: nenhuma API externa ou chave.
Monorepo pnpm + Turborepo, TypeScript, ESM. Pacotes exportam `src/index.ts` direto (sem build); apps rodam via `tsx`.

## Mapa de pastas
| Pasta | Area | Conteudo |
|---|---|---|
| packages/shared | contratos | Zod + tipos: entidades, DTOs `/api/v1`, eventos SSE, `Citation {documentId,page,snippet,n}` |
| packages/db | banco | schema Drizzle (11 tabelas), `migrations/*.sql` (RLS, HNSW, GIN), `createDb`, `withOrg` |
| packages/llm | LLM/RAG-core | `LLMProvider`, `Reranker`, providers `local` e `ollama`, `createLLM()` |
| packages/config | config | `loadConfig()` (env validado por Zod) |
| packages/queue | fila | `Queue`, `MemoryQueue` (padrao) e `BullQueue` (BullMQ, com `REDIS_URL`) |
| packages/storage | storage | `Storage`, `FsStorage` (padrao) e `S3Storage` (S3/MinIO, com `S3_ENDPOINT`) |
| apps/api | API | Express 5 (ver `API-EXPRESS.md`), rotas em `/api/v1`, SSE, auth |
| apps/worker | ingestao | `startWorker(queue)`: extrair -> chunk -> embed -> gravar |
| apps/web | frontend | Next.js + Tailwind |
| evals/ | avaliacao | datasets e runner (grava `eval_runs`) |
| infra/ | infra | docker-compose (Postgres+pgvector, Redis, MinIO) |
| .github/workflows | CI | typecheck, lint, test |
| docs/ | docs | este arquivo e demais |

Regra: mudanca em contrato (`shared`, schema do `db`) afeta todos os consumidores; atualize-os no mesmo commit.

## Contratos entre pacotes
- `shared` nao depende de nada interno; todos os demais podem depender dele.
- `db`: `createDb({databaseUrl?, pgliteDir?}) -> {db, kind, migrate(), close()}`.
  `withOrg(db, orgId, tx => ...)` abre transacao, faz `SET LOCAL ROLE docmind_app` e `app.org_id`; TODA query de dados de tenant deve passar por ele.
  A conexao crua (`handle.db`) e privilegiada (ignora RLS): so para auth/login, worker e migrations.
- `llm`: `embed(texts) -> number[384][]`, `generateStream(messages) -> AsyncIterable<string>`, `generateObject(zodSchema, messages)`.
  O gerador `local` e extrativo: le linhas `[n] trecho` nas mensagens e responde citando `[n]`. Embeddings sempre 384 dims (coluna `vector(384)`).
- `queue`: `enqueue(name, payload)`, `process(name, handler)`. Job de ingestao: `INGEST_QUEUE` / `IngestJob` em apps/worker.
- `storage`: `put/get/delete(key)`. Chave sugerida: `{orgId}/{documentId}/{filename}`.
- `config`: variaveis em `.env.example`. `LLM_PROVIDER=local|ollama`, `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`.
- API/SSE: `POST /api/v1/conversations/:id/messages` responde `text/event-stream`; eventos `SseEvent` (`token`, `citations`, `done`, `error`).

## Decisoes
- Banco: PGlite (+pgvector, WASM) sem Docker em dev/testes; Postgres real quando `DATABASE_URL` setado. Mesmo SQL de migration nos dois.
  Teste em memoria: `createDb({pgliteDir: ':memory:'})`. PGlite aceita UM processo por diretorio.
- Fila: em memoria por padrao. Como memoria nao cruza processos, no modo local sem Redis a API deve chamar `startWorker(queue)` in-process; worker separado so com `REDIS_URL`.
- Storage: filesystem em `STORAGE_DIR` (padrao `./data/storage`); S3/MinIO se configurado.
- LLM: `local` (hashing-trick 384d + extrativo + reranker BM25). `ollama` opcional via `OLLAMA_URL`.
- Busca hibrida: HNSW (cosseno) + GIN tsvector (`to_tsvector('simple', content)`), fusao e rerank no codigo.
- Multi-tenant: `organization_id` em todas as tabelas; RLS FORCE com policy `organization_id = current_setting('app.org_id')`.

## Como rodar
```
corepack enable   # ou: npm i -g pnpm
pnpm install
cp .env.example .env
pnpm typecheck && pnpm test && pnpm lint && pnpm build
pnpm dev          # turbo: api :3001, worker, web :3000
curl localhost:3001/api/v1/health
```
Postgres real: subir `infra/docker-compose.yml` e setar `DATABASE_URL`.

## Pendencias conhecidas
- OpenAPI: gerado dos schemas Zod por `packages/shared/src/openapi.ts` (tabela `ROUTES`; editar ao criar ou mudar rota) e servido em `GET /api/v1/openapi.json`.
- `ollama.dims` assume modelo de embedding de 384d.
- Migrations: runner simples (`migrate()` so aplica se `organizations` nao existe); trocar por drizzle-kit/tabela de controle ao evoluir o schema.
