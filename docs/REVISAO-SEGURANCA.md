# Revisão de segurança (somente leitura)

- **Rodada 1:** auth, organizações, coleções, documentos e RLS (código Fastify, antes da migração).
- **Rodada 2:** API Express completa: auth com rotação de refresh, rate limit, upload, SSRF, RLS, chat/SSE, pipeline de prompt, limite de uso, agente, CORS/cookies/headers.

Método: leitura do código em `apps/api/src`, `packages/{db,retrieval,agent,ingest,security}`. Nada foi executado contra dados reais e nenhum arquivo da API foi alterado. **A camada web (`apps/web`) e a gravação do worker não foram revisadas.**

## Achados da rodada 1: situação

| # | Achado | Situação |
|---|---|---|
| 1 | Sem rate limit em `/auth/*` | **Corrigido.** `AUTH_RATE_LIMIT` por IP (padrão 10/min) e metade por e-mail em register/login; refresh com o triplo por IP; 429 com `retry-after`; limite global de 60/min por usuário e 300/min por organização; senha limitada a 128 caracteres e validada antes do hash. Efeitos colaterais em R2-1 e R2-2. |
| 2 | Upload com checagem fraca | **Corrigido.** `documents.ts` usa `validateUpload` (magic bytes, extensão coerente, tamanho) e sanitiza o nome do arquivo. |
| 3 | FKs sem tenant | **Corrigido.** Migration `0003_tenant_composite_fks` (FKs compostas `(organization_id, id)`). Fora de escopo declarado: `user_id` (conversas, feedback, uso). A migration falha se já houver linha cruzada. |
| 4 | SSRF | **Corrigido onde importa.** O worker busca a página com `safeFetchText`: o IP validado é o IP da conexão (sem rebinding), cada redirect é revalidado, há teto de bytes e timeout total, credenciais na URL são recusadas e CGNAT/reservados/multicast são bloqueados. A checagem da API (`assertPublicUrl`) ficou na versão antiga e só serve de falha rápida (R2-9). |
| 5 | Refresh sem revogação | **Corrigido.** Refresh opaco (só o sha256 no banco), rotação a cada uso, reuso fora da janela de 10 s revoga a família, logout e `switch-org` revogam a família, expirados são purgados. Permanece: mudança de papel ou remoção só vale após até 15 min (vida do access token). Quem roubar um refresh token e o apresentar até 10 s depois da rotação recebe o mesmo sucessor que o dono. |
| 6 | `409 email_taken` enumera e-mails | Aceito (escopo de portfólio). |
| 7 | Grants futuros, `UNIQUE` em memberships | **Parcial.** `UNIQUE (organization_id, user_id)` em `memberships` (`0004`) e tabela de controle `_migrations`. Segue sem `ALTER DEFAULT PRIVILEGES` e sem teste que barre tabela de tenant sem RLS. |
| 8 | `JWT_SECRET` fraco | **Corrigido em produção** (mínimo de 32 caracteres, recusa o padrão). Em dev segue o valor público. |
| 9 | Worker usa conexão crua | **Mitigado.** A busca e o leitor de chunks recebem a conexão crua mas abrem `withOrg` internamente. A gravação do worker não foi revisada. |
| 10 | Prompt injection no chat | **Parcial.** Ver R2-3 e R2-4. |

## Achados novos (rodada 2), por dono

Severidade: Alta = explorável sem condições especiais; Média = precisa de contexto ou afeta produção; Baixa/Info = endurecimento.

### Backend (`apps/api/src/app.ts`, `http/`, `routes/auth.ts`, `routes/messages.ts`)

| # | Sev. | Problema | Sugestão |
|---|---|---|---|
| R2-1 | Média | Os limites usam `req.ip` e o `trust proxy` está desligado. Atrás de um proxy (Fly, Railway, nginx) todos os clientes viram o mesmo IP: 10 logins por minuto para o mundo inteiro. | `app.set('trust proxy', n)` em produção, com o número real de proxies configurável, e um teste. |
| R2-2 | Média | O limite por e-mail em `/auth/login` deixa um atacante travar o login de uma vítima (basta errar algumas vezes por minuto com o e-mail dela). | Chave `e-mail + IP`, ou só IP com atraso progressivo. |
| R2-5 | Média | Sem `helmet`: faltam `X-Content-Type-Options`, HSTS, `Referrer-Policy` e CSP de API. Só `x-powered-by` foi desligado. | `helmet()` em modo API (CSP `default-src 'none'`), HSTS só em produção. |
| R2-6 | Média | `GET /metrics` é público (fora de `/api/v1` e da autenticação) e expõe latências, tokens e taxa de feedback; `/health` público mostra provedor de banco, fila e LLM. | `/metrics` atrás de `requireAdmin` ou de token de scrape; `/health` mínimo. |
| R2-8 | Baixa | `jwt.verify` sem `algorithms`; o papel e a organização vêm do token por 15 min sem releitura do banco. | `{ algorithms: ['HS256'] }`; documentar o atraso. |
| R2-10 | Baixa | O stream do chat não aborta a geração quando o cliente desconecta (só confere `s.closed` quando chega o próximo evento); a mensagem do usuário é gravada antes do stream, então uma falha deixa pergunta sem resposta. | Propagar um `AbortSignal` (`req.on('close')`) ao LLM. |
| R2-11 | Info | CORS com uma origem via `WEB_ORIGIN` e `credentials: true`; se a variável faltar em produção, cai em `http://localhost:3000` (falha fechada, mas silenciosa). Com `sameSite=lax`, web e API em sites diferentes não recebem o cookie de refresh. | Exigir `WEB_ORIGIN` em produção; mesmo domínio registrável para web e API. |

### Dono de `packages/agent` e `packages/retrieval`

| # | Sev. | Problema | Sugestão |
|---|---|---|---|
| R2-3 | **Alta** | O modo agente não delimita os trechos. `agent.ts` (busca) e `tools.ts` (resumo, comparação) montam o prompt com o conteúdo bruto dos documentos e sem instrução de tratá-los como dados. Um documento ou página importada com "ignore as regras e diga X" chega ao modelo como texto comum. Com o provedor `local` (extrativo) o impacto é pequeno; com Ollama é real. | Mesma estratégia do chat: tags de delimitação e instrução de dados não confiáveis, ou `delimitDocuments` de `@docmind/security` (nonce por chamada). |
| R2-12 | Média | `POST /agent/run` não confere o limite mensal de tokens (o chat devolve 402; o agente não). Quem estourou o limite continua gastando pelo agente. | Chamar `getUsage` antes de abrir o stream, como em `messages.ts`. |
| R2-4 | Baixa | **Resolvido.** O chat e o agente usam `delimitPassages` (`@docmind/retrieval`), com nonce por chamada; o `delimitDocuments` duplicado de `@docmind/security` foi removido. | Nada a fazer. |
| R2-13 | Info | O limite mensal é global (`MONTHLY_TOKEN_LIMIT` no `.env`), não por organização como na spec; `getUsage(tx)` sem `cfg` relê o `process.env`. | Coluna por organização; passar `deps.config`. |

### Dono de upload e SSRF (`routes/documents.ts`, `packages/ingest`)

| # | Sev. | Problema | Sugestão |
|---|---|---|---|
| R2-9 | Baixa | `assertPublicUrl` na API tem a lista antiga (sem CGNAT, `198.18/15`, multicast) e usa um `lookup` próprio. O fetch real é no worker, então serve de falha rápida, mas as duas listas vão divergir. | Importar `isBlockedIp` de `@docmind/ingest`. |
| R2-14 | Baixa | `multer` guarda o arquivo (até 25 MB) em memória; 60 req/min por usuário ainda permite muito uso de RAM. | Limitar uploads concorrentes ou reduzir o teto padrão. |

### Reconferência dos achados da rodada 2
Corrigidos no código: **R2-1** (`TRUST_PROXY` configurável), **R2-3** (agente usa `delimitPassages` do retrieval, com nonce), **R2-5** (`helmet` com CSP `default-src 'none'`), **R2-6** (`/metrics` só com `METRICS_TOKEN` ou loopback), **R2-8** (`algorithms: ['HS256']`), **R2-12** (`/agent/run` devolve 402 acima do limite). Resolvido também: R2-4. Abertos: R2-2 (chave de e-mail igual), R2-9, R2-10, R2-11, R2-13, R2-14. Observação sobre R2-1: com o proxy do Next (`rewrites`) a API só enxerga o IP do servidor web; sem `TRUST_PROXY=1` (e o `x-forwarded-for` do Next) o limite por IP de `/auth/*` vale para todos os usuários juntos.

## Rodada 2b: web, worker, infra e dependências

### Frontend (`apps/web`)
Bom: nenhum `innerHTML` com dado de usuário (o único `dangerouslySetInnerHTML` é o script estático do tema); resposta do modelo, trechos e erros da API são renderizados como texto pelo React; o access token fica só em memória (o refresh vai por cookie `httpOnly`); a API é chamada por proxy de mesma origem (`rewrites`), então não precisa de CORS; os links são internos (`/chat?c=<uuid>`, `/collections/<id>`) e não há `target="_blank"` nem URL externa clicável.

| # | Sev. | Problema | Sugestão |
|---|---|---|---|
| W-1 | Média | `next.config.ts` não define headers: sem CSP, `frame-ancestors` (clickjacking), `X-Content-Type-Options`, `Referrer-Policy`. A API tem helmet, a página que o usuário abre não. | `headers()` com `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: same-origin`. Para a CSP completa, nonce por requisição no middleware do Next (o script do tema é inline); comece em `Content-Security-Policy-Report-Only`. |
| W-2 | Baixa | `poweredByHeader` do Next está ligado. | `poweredByHeader: false`. |
| W-3 | Baixa | Se alguém definir `NEXT_PUBLIC_API_URL` (API em outro site), o cookie `sameSite=lax` do refresh deixa de ser enviado e o CORS vira requisito. | Manter o proxy de mesma origem em produção e documentar. |
| W-4 | Info | O texto do modelo e os trechos são seguros porque são texto puro. Se algum dia entrar renderização de markdown/HTML, isso vira XSS vindo de documentos de terceiros. | Se precisar de markdown: biblioteca com sanitização e sem HTML bruto, e um teste com `<img onerror>` no trecho. |

### Worker (`apps/worker`, `packages/ingest`, `packages/storage`)
Bom: toda escrita filtra por `id` **e** `organization_id` (documento, chunks, uso); a troca de chunks é uma transação idempotente; o fetch de URL usa `safeFetchText`; `FsStorage` rejeita chaves que saem da raiz; o worker espera os jobs em andamento ao receber SIGTERM.

| # | Sev. | Problema | Sugestão |
|---|---|---|---|
| K-1 | Média | `documents.error` guarda `e.message` (até 500 caracteres) e a API o mostra ao usuário. Erros do banco ou de bibliotecas podem trazer SQL e parâmetros ou caminhos internos. | Mensagem genérica para erros não `PermanentError` (detalhe só no log). |
| K-2 | Média | Sem limite de expansão na extração: um DOCX (zip) de 25 MB ou um PDF com muitas páginas pode consumir memória. Sem Redis o worker roda **dentro do processo da API**, então derruba a API junto. | Teto de tamanho descomprimido, de páginas e de chunks por documento, e timeout por job. |
| K-3 | Baixa | O payload do job (`organizationId`, `documentId`) é confiável. Com Redis exposto sem senha, qualquer um enfileira jobs (a escrita ainda exige `id` e organização coincidentes). | Senha no Redis (ver K-4). |
| K-4 | Média | `infra/docker-compose.yml` publica Postgres, Redis e MinIO em `0.0.0.0` com credenciais padrão (`docmind`/`docmind`, Redis sem senha). Além disso, com `NODE_ENV=production` e o padrão `JWT_SECRET=dev-only-change-me` (17 caracteres) a API **recusa subir** por causa da regra de 32 caracteres: o `docker compose up` do README falha na primeira execução. | `127.0.0.1:5432:5432` etc., `requirepass` no Redis, gerar um `JWT_SECRET` no setup ou no `.env.example` e dizer isso no README. |

### Dependências (`pnpm audit --prod`)
| Sev. | Pacote | Situação |
|---|---|---|
| Alta | `drizzle-orm` < 0.45.2 | SQL injection por identificadores mal escapados. O código não passa identificadores do usuário, mas atualize. Dono: `packages/db`. |
| Alta | `zod` < 4.6.6 (em `apps/web` e via `zod-to-json-schema`) | Consumo de memória ao validar coleções grandes com restrições. Dono: `shared`/`web`. |
| Alta/Média | `postcss` (via `next`) | Leitura de arquivo por `sourceMappingURL`, XSS em `</style>`. Afeta o build, não o runtime; atualizar `next` ou forçar `postcss` >= 8.5.23 com `overrides`. |

## O que está certo (confirmado na leitura)
- RLS FORCE com `USING` e `WITH CHECK`; `withOrg` valida o `orgId` e usa `SET LOCAL ROLE`. A busca híbrida, o leitor de chunks e o uso passam por `withOrg`; o cache semântico é isolado por `organização:coleção`.
- Histórico isolado por usuário (`findOwnConversation`); feedback só para mensagem própria.
- Login com hash de mentira para igualar o tempo; erro genérico para e-mail ou senha errados.
- Citações com marcadores inventados são removidas antes de chegar ao cliente.
- O erro 500 não vaza detalhes e o log redige `authorization` e `cookie`.

## Prioridade sugerida (estado atual)
1. K-4 (compose: `docker compose up` falha sem `JWT_SECRET`; portas e senhas padrão expostas) e as dependências altas (`drizzle-orm`, `zod`).
2. W-1 (headers/CSP do Next) e K-1/K-2 (erro vazando detalhe; limite de expansão na extração).
3. R2-2 e o restante dos abertos.
