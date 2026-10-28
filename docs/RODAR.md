# Como rodar

Nenhuma chave externa é necessária: banco, fila, storage, embeddings e geração têm modo local.
Requisitos: Node 22+ e pnpm 12 (`corepack enable`). Docker só para o modo com serviços reais.

## A. Sem Docker (PGlite, 1 comando)
```bash
pnpm install
cp .env.example .env        # defaults já funcionam
pnpm dev                    # web :3000, API :3001
pnpm demo:seed              # opcional: dados de exemplo (a API precisa estar rodando)
```
- Login do seed (só dev): `demo@docmind.dev` / `demo-docmind-123`.
- Banco = PGlite em `./data/pglite`, arquivos em `./data/storage`, fila em memória. O worker roda **dentro da API**; o processo `apps/worker` avisa e sai (PGlite aceita um processo por diretório). Para zerar tudo, pare o `pnpm dev` e apague `./data`.
- Conferir: `curl localhost:3001/api/v1/health`; `pnpm smoke` (fluxo completo em memória); `pnpm verify` (build, tipos, lint e testes); `pnpm eval` (qualidade da busca).

## B. Com Docker Compose (Postgres + pgvector, Redis, MinIO)
```bash
docker compose -f infra/docker-compose.yml up --build
```
Sobe `postgres`, `redis`, `minio` (+ criação do bucket), `api`, `worker` e `web`. Com `REDIS_URL` a fila é BullMQ e o worker é um processo próprio.
- Web `http://localhost:3000`, API `http://localhost:3001`, console MinIO `http://localhost:9001`. Postgres, Redis e MinIO escutam só em `127.0.0.1`.
- Os defaults do compose (senhas, `JWT_SECRET`) são **só para dev**. Para qualquer ambiente exposto crie `infra/.env` com `JWT_SECRET` (mínimo 32 caracteres: com `NODE_ENV=production` a API recusa subir com menos ou com o valor padrão), `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD` e `METRICS_TOKEN`.
- Popular com dados de exemplo: `pnpm demo:seed` (usa `DEMO_API_URL`, padrão `http://localhost:3001`).
- **Verificado** em 28/10/2026 (Docker 29.7): build das 3 imagens; `up -d` com tudo saudável; `/api/v1/ready` 200 (banco e Redis); web 200 e proxy da web para a API 200; `SMOKE_URL=http://localhost:3001 pnpm smoke` contra Postgres + BullMQ + MinIO: 11/11. Não testado em Linux nem em CI.
- **pgvector ≥ 0.8 é obrigatório:** a busca usa `hnsw.iterative_scan`. O compose usa a imagem `pgvector/pgvector:0.8.2-pg16`; num Postgres próprio, instale uma versão equivalente.
- **MinIO** vem de `bitnamilegacy/minio` (imagem congelada, **só para desenvolvimento**). Em produção use S3 gerenciado e preencha `S3_ENDPOINT`/`S3_*`.
- **Redis com senha:** `REDIS_PASSWORD` (padrão de dev em `infra/.env.example`; troque fora de dev). As portas do host são configuráveis com `POSTGRES_PORT` e `REDIS_PORT` (sempre em `127.0.0.1`), útil quando 5432/6379 já estão ocupadas.
- **`pnpm install`** exige os scripts de build liberados (`allowBuilds` em `pnpm-workspace.yaml`, já configurado: `esbuild`, `sharp` e `unrs-resolver` permitidos).

## Variáveis do `.env` (`packages/config` valida todas)
| Grupo | Variável | Efeito |
|---|---|---|
| Geral | `NODE_ENV`, `API_PORT`, `WEB_PORT` | Ambiente e portas (3001 e 3000) |
| Auth | `JWT_SECRET` | Assina os tokens; em produção 32+ caracteres |
| | `AUTH_RATE_LIMIT` | Tentativas/min por IP em login e registro (10) |
| Banco | `DATABASE_URL` | Vazio = PGlite; preenchido = Postgres real |
| | `PGLITE_DIR` | Pasta do PGlite (`./data/pglite`) |
| Fila | `REDIS_URL` | Vazio = memória, worker dentro da API; preenchido = BullMQ, worker separado |
| Arquivos | `STORAGE_DIR` | Pasta local (`./data/storage`) |
| | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Preenchendo `S3_ENDPOINT` usa S3/MinIO |
| LLM | `LLM_PROVIDER` | `local` (padrão, determinístico, sem rede), `ollama` ou `openai` (opcional; ver abaixo) |
| | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_EMBED_MODEL`, `OPENAI_CHAT_MODEL` | Só com `LLM_PROVIDER=openai`: a chave é obrigatória (o boot falha sem ela) e só é lida do `.env` por `packages/config`. Padrões: `text-embedding-3-small` (com `dimensions: 384`) e `gpt-4o-mini` |
| | `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_EMBED_MODEL` | Ollama, ex. `http://localhost:11434`. O modelo de embedding precisa ter 384 dimensões (`all-minilm`) |
| Ingestão | `WORKER_CONCURRENCY` | Documentos em paralelo por worker (1) |
| | `INGEST_MAX_PAGES`, `INGEST_MAX_CHUNKS`, `INGEST_MAX_DOCX_MB`, `INGEST_MAX_DOCX_RATIO`, `INGEST_JOB_TIMEOUT_S` | Tetos contra PDF/DOCX gigantes (ver `docs/WORKER.md`) |
| | `INGEST_LLM_CONTEXT` | `false` (padrão): o contexto de cada chunk é uma frase determinística. `true`: o LLM gera o contexto, **1 chamada de chat por chunk**; com provedor externo isso custa tokens e envia o texto do documento uma segunda vez |
| Uso | `MONTHLY_TOKEN_LIMIT`, `USAGE_PRICE_IN_PER_1M`, `USAGE_PRICE_OUT_PER_1M` | Limite mensal de tokens (402 ao exceder) e preços em USD |
| Busca (RAG) | `RAG_MIN_RELEVANCE` | Abaixo desta relevância (0 a 1, score do rerank no melhor trecho) o chat e o agente respondem "não encontrei" (0.17; 0 desliga). Recalibre ao trocar de reranker ou corpus: 0.30 abstém em todas as perguntas sem resposta dos evals, mas perde ~1/3 das respostas |
| | `RAG_W_RERANK`, `RAG_W_SIM`, `RAG_W_RRF` | Pesos relativos da ordenação dos trechos: rerank, similaridade vetorial e fusão RRF (0.8, 0.1, 0.1) |
| | `RAG_TOP_K` | Trechos enviados ao gerador (6) |
| Rede | `CORS_ORIGINS`, `TRUST_PROXY` | Origins permitidos (nunca `*`); atrás de proxy, saltos ou CIDRs confiáveis. Cloudflare → cloudflared → web → api: `TRUST_PROXY=2` (ou `loopback,uniquelocal`); sem isso o limite por IP vira global (IP do container) |
| | `CLIENT_IP_HEADER` | Ex.: `cf-connecting-ip`. Só é lido se o salto direto for confiável por `TRUST_PROXY` (exige CIDRs ou saltos, nunca `true`) |
| | `RATE_LIMIT_READ`, `RATE_LIMIT_WRITE` | Limites por minuto e por usuário (300 e 60) |
| Métricas | `METRICS_TOKEN` | Protege `GET /metrics` (16+ caracteres); vazio = só loopback |

## Problemas comuns
- **Documento fica `pending`:** o upload só cria o registro; chame `POST /documents/:id/process` (a interface faz isso).
- **Rodar o `reindex` (ou qualquer outro processo) com PGlite:** pare a API antes; dois processos no mesmo `PGLITE_DIR` corrompem o banco.
- **Trocou o embedding (provider ou modelo):** reembede com `pnpm --filter @docmind/worker reindex`.
- **Porta ocupada:** mude `API_PORT`/`WEB_PORT` no `.env`.

## Usar a OpenAI (opcional)
1. No `.env`: `LLM_PROVIDER=openai` e `OPENAI_API_KEY=...` (o `.env` está no `.gitignore`; nunca cole a chave em chat, log ou commit).
2. **Reindexe**: `pnpm reindex --yes`. Embeddings locais e OpenAI não são comparáveis; sem reindexar a busca devolve resultados ruins. O script mostra o provider e o modelo e exige `--yes` antes de enviar os documentos à OpenAI. Pare a API antes se usar PGlite (um processo por diretório).
3. Custo: defina `MONTHLY_TOKEN_LIMIT` (a API responde 402 ao exceder) e `USAGE_PRICE_IN_PER_1M` / `USAGE_PRICE_OUT_PER_1M` com os preços do modelo de chat (padrão 0: o painel de uso mostra custo zero). O provider informa os tokens reais de cada chamada; `modelPricing` em `@docmind/llm` guarda a tabela de referência.
   Preços em US$ por 1M de tokens (entrada / saída), **verificados em 2026-10-28** em developers.openai.com/api/docs/pricing; reconfira antes de confiar:
   | Modelo | Entrada | Saída | Uso |
   |---|---|---|---|
   | `gpt-4o-mini` | 0,15 | 0,60 | **padrão** (`OPENAI_CHAT_MODEL`) |
   | `text-embedding-3-small` | 0,02 | — | **padrão** (`OPENAI_EMBED_MODEL`) |
   | `gpt-5-nano` | 0,05 | 0,40 | opção mais barata, sem teste real aqui |
   | `gpt-5-mini` | 0,25 | 2,00 | opção, sem teste real aqui |
   | `gpt-6-luna` | 0,10 | 0,50 | opção, sem teste real aqui |
   O padrão continua `gpt-4o-mini` por ser o conhecido e compatível com `temperature` e streaming; modelos mais novos podem recusar parâmetros, então troque só depois de testar.
4. O reranker continua local (BM25 + cosseno): não há chamada extra. Voltar ao `local` também exige reindexar.

**Dimensões do embedding.** O provider pede `dimensions: 384` (a coluna é `vector(384)`). Se a API recusar o parâmetro (400 citando "dimension"), ele pede o tamanho nativo, usa os 384 primeiros valores e renormaliza (L2) no cliente — válido só para a família `text-embedding-3` (vetores Matryoshka) — e lembra o modo. Que a API aceite `dimensions: 384` ainda **não foi confirmado** (a documentação consultada não cita esse valor); só um teste real mostra qual caminho vale.

## Gravar o vídeo da demonstração (~2 min)
`pnpm --filter @docmind/tests video` (fora do gate de testes: `tests/playwright.video.config.ts`, spec `tests/e2e/video-2min.spec.ts`). Sobe um stack **local e isolado** (portas livres, PGlite em memória, storage temporário, build do web em `apps/web/.next-video`, todos apagados ao fim) na configuração de produção (`next build` + `next start`, API com `NODE_ENV=production` e `LLM_PROVIDER=openai`, pesos de ranking calibrados para a OpenAI e `GLOBAL_MONTHLY_TOKEN_LIMIT=0` só nesse processo). Precisa de `OPENAI_API_KEY` no `.env`, que a API lê sozinha; custa centavos. Cria uma conta fictícia (`ana@exemplo.com`), envia `scripts/demo-docs` + `evals/agent/corpus/tabela-precos.md` e grava 1280x720 com legendas e cursor desenhados na página. Saídas: `docs/demo/docmind-2min.webm` e, com `ffmpeg` no PATH, `docmind-2min.mp4` (H.264) e o GIF curto `docmind-demo.gif`.
