# Worker de ingestão

Código: `apps/worker` (fila, banco, status) e `packages/ingest` (extração, chunking, embeddings, sem I/O de banco).
Sem REDIS_URL o worker roda dentro da API (`apps/api/src/main.ts`); com Redis, como processo próprio (`pnpm --filter @docmind/worker start`).

## Fluxo
Fila `INGEST_QUEUE = 'ingest-document'`, payload `{organizationId, documentId}`.
1. `processDocument` carrega o documento (filtrando por organização) e marca `processing`.
2. `ingest()`: extrai (PDF por página, DOCX, TXT, MD, HTML/URL) → limpa (cabeçalho/rodapé repetidos, hifenização) → chunk (~500 tokens, 15% de sobreposição, página de início e seção) → contexto do chunk → embeddings em lotes de 32.
3. Numa transação apaga os chunks antigos do documento e insere os novos (reprocessar é idempotente), grava `usage_events` `ingest` e `embed`.
4. Marca `ready` (com `page_count`) ou `failed` (com `error`) e chama `invalidateCache({organizationId, collectionId})`.

Status: `pending → processing → ready | failed`. O SSE `/documents/:id/events` consulta o banco. `onStatus` é opcional.
Contexto do chunk: por padrão, em qualquer provider, uma frase determinística (documento, seção, página). `INGEST_LLM_CONTEXT=true` (opt-in) pede ao LLM, 1 chamada de chat por chunk (custo e privacidade com provedor externo), com fallback para a determinística. O contexto entra só no embedding; `chunks.content` guarda o texto original. Provider via `createLLMFromConfig` (`LLM_PROVIDER`); cada chunk grava `embedding_model` (ex. `local:hash-v2:384`, `openai:text-embedding-3-small:384`) e os `usage_events` usam os tokens reais do provedor quando ele informa (senão a estimativa). Embeddings saem em lotes de no máximo 100.

## Retries
- Falha transitória (rede, 5xx, 429, embedding): até 2 retries com backoff exponencial (base 500 ms). Provedor externo (`openai`) já faz o próprio backoff: falha dele vira `provider_error` sem retry aqui, para não empilhar tentativas nem reembedar (e recobrar) lotes já pagos; reprocesse depois.
- `PermanentError` não repete: tipo não suportado, arquivo corrompido, documento sem texto, 4xx, URL bloqueada.
- Esgotadas as tentativas, o documento vira `failed`. O worker nunca lança.

## Erros e limites
`documents.error` guarda só uma mensagem controlada por categoria (`USER_MESSAGES` em `packages/ingest/src/types.ts`); o detalhe técnico (caminhos, mensagens de libs) vai só para o log. Categorias: `unsupported_type`, `corrupt_file`, `unsafe_file`, `no_text`, `url_blocked`, `fetch_failed`, `too_large`, `timeout`, `provider_error`, `internal` (qualquer erro não classificado).
Tetos contra expansão, em `packages/config` (`.env.example`); estourar um deles falha o documento sem retry:
- `INGEST_MAX_PAGES` (500): páginas de PDF, checado antes de extrair o texto.
- `INGEST_MAX_CHUNKS` (5000): chunks por documento, checado antes de gerar contexto e embeddings.
- `INGEST_MAX_DOCX_MB` (100) e `INGEST_MAX_DOCX_RATIO` (100:1, só acima de 1 MB): zip bomb, medido no diretório central do ZIP sem descomprimir.
- `INGEST_JOB_TIMEOUT_S` (300): tempo por job, retries incluídos; checado entre etapas e lotes de embedding, a extração em si não é interrompível.

## Recuperação e concorrência
- No boot, documentos em `processing` voltam para a fila (`recoverStuck`). Sem `updated_at` não há timeout; assume um único worker.
- `WORKER_CONCURRENCY` (padrão 1) limita jobs simultâneos por processo. O mesmo documento nunca roda em paralelo.
- SIGINT/SIGTERM: `stop()` espera os jobs correntes e descarta os que não começaram (ficam como estavam).
- Reembeddar tudo (ex.: após mudar o embedding): pare a API e rode `pnpm --filter @docmind/worker reindex`.

## Importação de URL (anti-SSRF)
`mimeType = 'text/x-url'`: o objeto no storage contém a URL; o worker baixa (`packages/ingest/src/safe-fetch.ts`).
- Só http(s), sem credenciais na URL. O IP resolvido é validado na própria conexão (sem janela de DNS rebinding).
- Bloqueia loopback, privados, link-local/metadata, CGNAT, multicast e reservados, em IPv4 e IPv6 (inclui `::ffff:` e NAT64).
- Máx. 5 redirects, cada um revalidado. Corpo até 10 MB, timeout total de 15 s, sem Accept-Encoding.
- Conteúdo principal via Readability. Limite conhecido: sem allowlist de domínios nem suporte a páginas renderizadas por JavaScript.
