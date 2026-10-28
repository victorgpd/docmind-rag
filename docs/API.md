# API REST `/api/v1`

Fonte da verdade: `GET /api/v1/openapi.json` (gerado de `packages/shared/src/openapi.ts` + schemas Zod em `packages/shared/src/api.ts`). Este guia resume e dá exemplos; em caso de dúvida vale o OpenAPI.
Base local: `http://localhost:3001/api/v1`. Corpo JSON, exceto upload (`multipart/form-data`) e streams (`text/event-stream`).

## Autenticação
- `POST /auth/register` e `POST /auth/login` devolvem `{ token, user }`. O `token` é um JWT de acesso (15 min), enviado em `Authorization: Bearer <token>`.
- O refresh token vai num cookie `httpOnly` (`refresh_token`, 7 dias, path `/api/v1/auth`). `POST /auth/refresh` troca o par (rotação); `POST /auth/logout` encerra a sessão.
- Senha: 8 a 128 caracteres, com letra e número. Papéis: `owner`/`admin` administram (membros, apagar coleção); `member` usa.
- `POST /auth/switch-org` troca a organização ativa (exige membership). Toda consulta é isolada por organização (RLS).
- Conta de demonstração (`DEMO_LOGIN_ENABLED=true`): `GET /auth/demo` → `{ enabled }` (ligada e preparada); `POST /auth/demo` entra sem senha com a sessão normal (`{ token, user, demo: true }` + cookie), 20/h por IP, 404 se desligada. A conta é somente leitura: fora de conversar (`POST /conversations`, `/conversations/:id/messages`, `/agent/run`), `POST /messages/:id/feedback` e da própria sessão, toda escrita responde `403 demo_read_only`.
- Públicas (sem token): `/health`, `/ready`, `/openapi.json`, `/auth/register|login|refresh|logout|demo`.

## Fluxo mínimo com curl
```bash
API=http://localhost:3001/api/v1
TOKEN=$(curl -s $API/auth/register -H 'content-type: application/json' \
  -d '{"email":"ana@acme.com","password":"senha-forte-1","name":"Ana","organizationName":"Acme"}' | jq -r .token)
AUTH="authorization: Bearer $TOKEN"

COL=$(curl -s $API/collections -H "$AUTH" -H 'content-type: application/json' -d '{"name":"Contratos"}' | jq -r .id)
DOC=$(curl -s $API/collections/$COL/documents -H "$AUTH" -F file=@contrato.pdf | jq -r .id)   # status: pending
curl -s -X POST $API/documents/$DOC/process -H "$AUTH"                                          # 202, entra na fila
curl -N $API/documents/$DOC/events -H "$AUTH"                                                   # SSE até ready/failed

CONV=$(curl -s $API/conversations -H "$AUTH" -H 'content-type: application/json' -d "{\"collectionId\":\"$COL\"}" | jq -r .id)
curl -N $API/conversations/$CONV/messages -H "$AUTH" -H 'content-type: application/json' \
  -d '{"content":"Qual o prazo de entrega?"}'                                                   # SSE: token, citations, done
```
Importar página web: `POST /collections/:id/documents/import` com `{"url":"https://..."}` (alias: `POST /documents/url` com `collectionId` no corpo). Depois chame `/process` como no upload.

## Endpoints
| Grupo | Rotas |
|---|---|
| system | `GET /health`, `GET /ready` (503 em shutdown ou dependência fora), `GET /openapi.json` |
| auth | `POST /auth/register` (201), `/auth/login`, `/auth/refresh`, `/auth/logout` (204), `/auth/switch-org`; `GET/POST /auth/demo`; `GET /organizations` |
| collections | `GET/POST /collections`, `GET/PATCH/DELETE /collections/:id` (delete: admin) |
| documents | `POST /collections/:id/documents` (campo `file`), `POST /collections/:id/documents/import`, `POST /documents/url`, `GET /documents` (filtros `collectionId`, `status`; paginação `limit` 1 a 100 e `cursor` = `nextCursor`), `GET /documents/:id`, `POST /documents/:id/process`, `DELETE /documents/:id` (204), SSE `GET /documents/events` e `GET /documents/:id/events` |
| conversations | `POST/GET /conversations`, `GET /conversations/:id` (com mensagens), `POST /conversations/:id/messages` (SSE), `POST /messages/:id/feedback` (`rating` up/down) |
| agent | `POST /agent/run`: execução **sem estado** (não grava conversa nem mensagem; registra só o uso). SSE: `plan`, `step`, `step_result`, `result` ou `error` |
| usage | `GET /usage?from=&to=` (tokens, custo, `monthlyTokenLimit`, `limitExceeded`, `serviceLimitReached` = teto global do serviço atingido) |
| organization | `GET /organization`, `GET/POST /organization/members`, `PATCH /organization/members/:userId` (admin) |

Status do documento: `pending → processing → ready | failed` (`error` traz a categoria da falha, ver `docs/WORKER.md`). `/process` só aceita `pending` ou `failed`; em `processing`/`ready` responde 409.
Uploads aceitam PDF, DOCX, TXT e MD até 25 MB; o tipo é validado pelo conteúdo, não pelo MIME declarado.

## Streams SSE
Formato: `event: <tipo>` + `data: <JSON>`. Em `/documents/events` e `/documents/:id/events` o evento é `document` com o documento atualizado (o stream por id fecha em `ready`/`failed`). Em `/conversations/:id/messages`:
```
event: token       data: {"type":"token","delta":"O prazo "}
event: citations   data: {"type":"citations","citations":[{"documentId":"…","page":3,"snippet":"…","n":1}]}
event: done        data: {"type":"done","messageId":"…","tokensIn":812,"tokensOut":64}
event: error       data: {"type":"error","message":"…"}
```
### Modo agente em `POST /conversations/:id/messages`
Com `{"content": "…", "agent": true}` o stream traz os mesmos eventos de `/agent/run` (`plan`, `step`, `step_result`, `result` ou `error`) e termina com `done`, que leva o `messageId`:
```
event: plan         data: {"type":"plan","intent":"compare"}
event: step         data: {"type":"step","n":1,"tool":"search","input":{…}}
event: step_result  data: {"type":"step_result","n":1,"tool":"search","ok":true,"ms":18}
event: result       data: {"type":"result","result":{"answer":"…","citations":[…],"data":…,"usage":{…}}}
event: done         data: {"type":"done","messageId":"…","tokensIn":812,"tokensOut":64}
```
- **Persistência:** a mensagem do assistente guarda a resposta e as citações; o payload da ferramenta (`intent`, `data` como a tabela extraída, `steps`, `truncated`) vai na coluna `messages.data` (migration `0006_messages_data.sql`, jsonb nulo para as mensagens comuns), então `GET /conversations/:id` recarrega o histórico completo.
- **Limite:** `402 usage_limit_exceeded` antes de abrir o stream, igual ao chat; um pedido inválido para o agente (ex.: mais de 2000 caracteres) é `400` antes de gravar qualquer coisa.
- **Abstenção:** no chat comum, se o melhor trecho fica abaixo de `RAG_MIN_RELEVANCE`, a resposta é "não encontrei" (sem inventar), com as citações vazias.
- Feche a conexão para abortar a geração.

## Erros
Formato único: `{ "error": { "code": "…", "message": "…" } }`.
| HTTP | `code` | Quando |
|---|---|---|
| 400 | `validation_error`, `invalid_url`, `no_file` | Corpo/query inválidos; URL bloqueada (privada, não resolve); upload sem campo `file` |
| 401 | `unauthorized`, `invalid_credentials` | Token ausente/inválido/expirado; login errado |
| 402 | `usage_limit_exceeded` | Limite mensal de tokens da organização esgotado (chat e agente) |
| 402 | `global_limit_exceeded` | Teto mensal do serviço (`GLOBAL_MONTHLY_TOKEN_LIMIT`, soma de todas as organizações) atingido: chat, agente e `/documents/:id/process` |
| 403 | `forbidden`, `registration_closed` | Exige papel admin, ou não é membro da organização; cadastro fechado (`REGISTRATION_ENABLED=false`) |
| 404 | `not_found`, `collection_not_found` | Recurso inexistente ou de outra organização |
| 409 | `email_taken`, `invalid_state`, `last_admin` | E-mail duplicado; reprocessar documento em andamento ou pronto; remover o último admin |
| 413 | `file_too_large` | Upload acima de 25 MB |
| 415 | `invalid_file` | Extensão fora de pdf/docx/txt/md, arquivo vazio ou conteúdo que não bate com a extensão |
| 429 | `rate_limited` | Limite por minuto (por usuário/organização; `/auth` tem limite próprio por IP; `/auth/register` também por IP a cada 24 h, `REGISTRATION_LIMIT_PER_IP_PER_DAY`). Header `Retry-After` em segundos |
| 500 | `internal_error` | Erro não tratado (detalhe só no log) |
Limites padrão: leituras 300/min, escritas 60/min por usuário, organização até 5x (`RATE_LIMIT_READ`, `RATE_LIMIT_WRITE`, `AUTH_RATE_LIMIT`).
