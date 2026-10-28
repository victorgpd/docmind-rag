import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Raiz do repositório: sobe a partir deste arquivo até o pnpm-workspace.yaml (cai no cwd se não achar). */
export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(resolve(d, 'pnpm-workspace.yaml'))) return d;
    if (dirname(d) === d) return process.cwd();
  }
}
const absolutize = (p: string) => (p === ':memory:' || isAbsolute(p) ? p : resolve(findRepoRoot(), p));


const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(3001),
  JWT_SECRET: z.string().default('dev-only-change-me'),
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('./data/pglite'),
  REDIS_URL: z.string().optional(),
  STORAGE_DIR: z.string().default('./data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  /** local (padrao, sem rede) | ollama | openai (opcional; envia os trechos e perguntas a api.openai.com). */
  LLM_PROVIDER: z.enum(['local', 'ollama', 'openai']).default('local'),
  /** Unico lugar onde a chave e lida; obrigatoria com LLM_PROVIDER=openai. Nunca logue nem devolva este valor (use redactConfig). */
  OPENAI_API_KEY: z.string().trim().regex(/^\S+$/,'OPENAI_API_KEY must not contain spaces or line breaks').optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  /** Com dimensions=384 (vector(384)). Trocar de modelo/provider exige reindexar (pnpm reindex). */
  OPENAI_EMBED_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4o-mini'),
  OLLAMA_URL: z.string().optional(),
  OLLAMA_MODEL: z.string().default('llama3.2'),
  OLLAMA_EMBED_MODEL: z.string().default('all-minilm'),
  /** Jobs de ingestao simultaneos por processo. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  /** Tetos da ingestao contra expansao: paginas de PDF, chunks por documento, bytes descomprimidos e razao de um DOCX, tempo por job. */
  INGEST_MAX_PAGES: z.coerce.number().int().positive().default(500),
  INGEST_MAX_CHUNKS: z.coerce.number().int().positive().default(5000),
  INGEST_MAX_DOCX_MB: z.coerce.number().positive().default(100),
  INGEST_MAX_DOCX_RATIO: z.coerce.number().positive().default(100),
  INGEST_JOB_TIMEOUT_S: z.coerce.number().positive().default(300),
  /** Opt-in: contexto de cada chunk gerado por LLM (1 chamada de chat por chunk; com provedor externo custa e envia o texto do documento). Padrao: frase deterministica. Nao use z.coerce.boolean: "false" viraria true. */
  INGEST_LLM_CONTEXT: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Origins permitidos no CORS, separados por virgula (com credentials, para o cookie de refresh). Nunca '*'. Padrao: o web local. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /** Atras de proxy reverso: 'true', numero de saltos ou lista de IPs/CIDRs confiaveis. Vazio = desligado (usa o IP da conexao). */
  TRUST_PROXY: z.string().optional(),
  /** Header com o IP do cliente (ex.: cf-connecting-ip), lido so quando o salto direto e confiavel por TRUST_PROXY (CIDRs/saltos; nao 'true'). Vazio = IP vem do X-Forwarded-For. */
  CLIENT_IP_HEADER: z.string().optional(),
  /** Se definido, GET /metrics exige `Authorization: Bearer <token>`; senao so responde a loopback. */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Limite por minuto e por usuario para leituras (GET/HEAD; abrir um SSE conta 1, os eventos nao contam). Padrao 300; a org soma ate 5x. Sem limite em NODE_ENV=test salvo se configurado. */
  RATE_LIMIT_READ: z.coerce.number().int().positive().optional(),
  /** Limite por minuto e por usuario para escritas, uploads e chat (POST/PATCH/DELETE). Padrao 60; a org soma ate 5x. */
  RATE_LIMIT_WRITE: z.coerce.number().int().positive().optional(),
  /** Tentativas por minuto e por IP em /auth/login e /auth/register (por e-mail: metade); refresh: o triplo. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  MONTHLY_TOKEN_LIMIT: z.coerce.number().int().positive().default(10_000_000),
  /** Teto mensal (mes UTC) somando TODAS as organizacoes: cadastro aberto cria uma org nova por conta, entao o limite por org sozinho nao tem teto. 0 desliga. */
  GLOBAL_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().nonnegative().default(2_000_000),
  /** Cadastros por IP a cada 24 h em /auth/register; 0 desliga. Padrao 5; sem limite em NODE_ENV=test salvo se configurado. */
  REGISTRATION_LIMIT_PER_IP_PER_DAY: z.coerce.number().int().nonnegative().optional(),
  /** false fecha o cadastro publico (403 registration_closed). Nao use z.coerce.boolean: "false" viraria true. */
  REGISTRATION_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Conta de demonstracao: POST /auth/demo entra sem senha e a conta e somente leitura (exceto conversar/feedback). false = rota 404. */
  DEMO_LOGIN_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** E-mail do usuario de demonstracao (criado por apps/api/src/scripts/demo-maintenance.ts); obrigatorio com DEMO_LOGIN_ENABLED=true. */
  DEMO_USER_EMAIL: z.string().email().transform((v) => v.toLowerCase()).optional(),
  USAGE_PRICE_IN_PER_1M: z.coerce.number().nonnegative().default(0),
  USAGE_PRICE_OUT_PER_1M: z.coerce.number().nonnegative().default(0),
  /**
   * Busca/RAG (packages/retrieval). Defaults calibrados nos evals (62 perguntas com resposta + 7 sem) com o LocalReranker:
   * abaixo de RAG_MIN_RELEVANCE (score absoluto do rerank no melhor trecho) a resposta é "não encontrei"; 0 desliga.
   * Recalibre ao trocar de reranker ou de corpus.
   */
  RAG_MIN_RELEVANCE: z.coerce.number().min(0).max(1).default(0.17),
  /** Pesos da interpolação rerank/similaridade vetorial/RRF na ordenação dos trechos (relativos entre si). */
  RAG_W_RERANK: z.coerce.number().nonnegative().default(0.8),
  RAG_W_SIM: z.coerce.number().nonnegative().default(0.1),
  RAG_W_RRF: z.coerce.number().nonnegative().default(0.1),
  /** Trechos enviados ao gerador. */
  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(6),
});
export type Config = z.infer<typeof Env>;

/** Cópia segura para log/diagnóstico: segredos viram "[set]"/"[unset]". */
export function redactConfig(c: Config): Record<string, unknown> {
  const secret = new Set(['OPENAI_API_KEY', 'JWT_SECRET', 'METRICS_TOKEN', 'S3_SECRET_KEY', 'S3_ACCESS_KEY', 'DATABASE_URL', 'REDIS_URL']);
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, secret.has(k) ? (v ? '[set]' : '[unset]') : v]));
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // string vazia (do .env.example) conta como "nao setado"
  const clean = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === '' ? undefined : v]));
  const config = Env.parse(clean);
  if (config.LLM_PROVIDER === 'openai' && !config.OPENAI_API_KEY)
    throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY (set it in .env; it is never read from anywhere else)');
  if (config.LLM_PROVIDER === 'ollama' && !config.OLLAMA_URL) throw new Error('LLM_PROVIDER=ollama requires OLLAMA_URL');
  if (config.DEMO_LOGIN_ENABLED && !config.DEMO_USER_EMAIL) throw new Error('DEMO_LOGIN_ENABLED=true requires DEMO_USER_EMAIL');
  // relativos resolvem pela raiz do repo, não pelo cwd (API e worker/reindex precisam abrir o mesmo banco)
  return { ...config, PGLITE_DIR: absolutize(config.PGLITE_DIR), STORAGE_DIR: absolutize(config.STORAGE_DIR) };
}
