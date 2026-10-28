# Segurança e observabilidade: como registrar na API

Dois pacotes, sem serviço externo: `@docmind/observability` e `@docmind/security`.
Para usar, adicione ambos em `apps/api/package.json` (`"workspace:*"`) e rode `pnpm install`.

## Montagem sugerida em `buildApp` (Express 5)

```ts
import express from 'express';
import { consoleExporter, observability, requestLogging } from '@docmind/observability';
import { createRateLimiter, rateLimit } from '@docmind/security';

const app = express();
app.use(requestLogging({ level: deps.config.NODE_ENV === 'test' ? 'silent' : 'info' })); // 1o: todo log leva reqId
app.use(observability({
  exporter: deps.config.NODE_ENV === 'development' ? consoleExporter() : undefined, // undefined = no-op
}));

// ... middleware de autenticação que preenche req.auth ...

app.use(rateLimit({ // DEPOIS da autenticação
  limiter: createRateLimiter(deps.config.REDIS_URL), // Redis se REDIS_URL, senão memória
  identify: (req) => ({ userId: req.auth?.userId, orgId: req.auth?.orgId }),
  user: { limit: 60, windowMs: 60_000 },
  org: { limit: 300, windowMs: 60_000 },
}));
```

`requestLogging` substitui `logger: true`: cada linha de log tem `reqId` e os headers `authorization`/`cookie` são redigidos. Nas rotas, use `req.log` (Pino) em vez de `console.log`.

## Observabilidade

| Peça | O que faz |
|---|---|
| `requestLogging({ level })` | middleware Pino (via `pino-http`): `req.id`/`req.log`, usa o `x-request-id` recebido ou gera UUID e o devolve no header |
| `observability(opts)` | `Router`: expõe `req.tracer` e `req.metrics`, mede a latência `http` e serve `GET /metrics` (JSON; `metricsRoute: ''` desliga) |
| `Tracer.span(name, fn)` | span estilo OpenTelemetry (traceId, spanId, pai automático); exporta para `consoleExporter` ou `noopExporter` |
| `Metrics` | latência por etapa, tokens por resposta, taxa de feedback positivo |

Instrumentar o RAG (nas rotas de chat):

```ts
const t0 = performance.now();
const hits = await req.tracer.span('retrieve', () => retrieve(q));
req.metrics.observeLatency('retrieve', performance.now() - t0);
// ... rerank, generate
req.metrics.observeTokens(usage.inputTokens + usage.outputTokens); // ao fechar a resposta
req.metrics.recordFeedback(rating === 'useful');                   // em POST /messages/:id/feedback
```

Para usar as métricas fora de uma requisição (worker), crie `new Metrics()` e passe em `observability({ metrics })`. Spans aninhados compartilham o `traceId` (via `AsyncLocalStorage`): envolva a pergunta inteira em `tracer.span('query', ...)` e as etapas viram filhas. Para um coletor OTLP real, implemente `SpanExporter` (um método, `export(span)`).

Limite conhecido: as métricas vivem na memória do processo e só guardam contagem, média e máximo (sem p95).

## Segurança

**Rate limit** (`rateLimit(opts)`): janela fixa, uma chave por usuário e outra por organização; estourou, responde `429` com `retry-after`. Rotas sem usuário caem para o IP. Se o Redis cair o middleware lança e o Express responde 500 (falha fechada). Limite conhecido: janela fixa permite rajada na virada da janela; a memória não é compartilhada entre instâncias, por isso `REDIS_URL` em produção.

**Upload** (`validateUpload`): o upload vai direto ao storage por URL assinada, então valide em `POST /documents/:id/process`, com o objeto já gravado:

```ts
import { HEAD_BYTES, validateUpload } from '@docmind/security';

const bytes = await storage.get(key);                 // ou só o início, se o storage permitir
const check = validateUpload(
  { filename, size: bytes.length, head: bytes.subarray(0, HEAD_BYTES) },
  { maxBytes: 20 * 1024 * 1024 },
);
if (!check.ok) { await storage.delete(key); return res.status(415).json({ error: { code: 'unsupported_type', message: check.reason } }); }
```

O tipo vem dos magic bytes (`%PDF-`, zip com `word/`, texto UTF-8 sem NUL); o MIME do cliente é ignorado e a extensão precisa bater com o conteúdo. Limite conhecido: o DOCX é reconhecido por `word/` nos primeiros 64 KB, e um zip genérico é rejeitado.

**Anti prompt injection:** fica em `delimitPassages` de `@docmind/retrieval` (nonce aleatório por chamada, instrução de que os trechos são dados, escape de `[n]` e de tags forjadas), usado pelo chat e pelo agente. Isso reduz o risco, mas não o elimina: um modelo pode obedecer texto dentro de dados. As outras camadas são o RLS (um prompt injetado não cruza organizações) e validar as citações da resposta.
