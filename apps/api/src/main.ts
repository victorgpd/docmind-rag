import { loadConfig } from '@docmind/config';
import { createDb } from '@docmind/db';
import { createLLMFromConfig } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { invalidate } from '@docmind/retrieval';
import { createStorage } from '@docmind/storage';
import { INGEST_QUEUE, ingestOptionsFromConfig, startWorker } from '@docmind/worker';
import { buildApp } from './app';
import { configureServer, gracefulShutdown } from './http/server';
import { purgeExpiredRefreshTokens } from './routes/auth';
import { notifyDocumentChange } from './routes/documents';
import { demoMaintenance } from './scripts/demo-maintenance';

const config = loadConfig();
// db.db e a conexao privilegiada (ignora RLS). So a usam: migrations, worker, auth/refresh_tokens, usuario demo (http/demo.ts),
// teto global (soma de todas as orgs), /ready e a manutencao da demo. Dado de organizacao passa por withOrg/orgScope (RLS).
const db = await createDb({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
await db.migrate();
const llm = createLLMFromConfig(config); // a chave (OPENAI_API_KEY) so passa por aqui; nunca logue o config inteiro (redactConfig)
const queue = createQueue({ redisUrl: config.REDIS_URL });
const storage = createStorage({ dir: config.STORAGE_DIR, s3Endpoint: config.S3_ENDPOINT });

// Sem Redis a fila e em memoria e nao cruza processos: o worker roda aqui, com o mesmo handle de db (PGlite aceita um processo).
// onStatus acorda o SSE de documentos na hora (sem ele, so no polling de 1 s).
// invalidateCache limpa o cache semantico da colecao quando o documento fica ready/failed.
const worker = config.REDIS_URL ? undefined : startWorker(queue, { db: db.db, storage, llm, ...ingestOptionsFromConfig(config), analyzeWhenIdle: db.kind === 'pglite', invalidateCache: invalidate, onStatus: (e) => notifyDocumentChange(e.organizationId) });
// O PGlite aceita um processo so: o script de manutencao da demo nao roda ao lado da API, entao ela o executa no boot (com Postgres, use o cron).
if (config.DEMO_LOGIN_ENABLED && db.kind === 'pglite')
  await demoMaintenance({ db: db.db, storage, email: config.DEMO_USER_EMAIL!, enqueue: (job) => queue.enqueue(INGEST_QUEUE, job) });
const app = buildApp({ config, db, llm, queue, storage });
const purge = () => purgeExpiredRefreshTokens(db.db).catch((e) => app.locals.log.error({ err: e }, 'refresh token purge failed'));
void purge();
setInterval(purge, 3600_000).unref();
const server = app.listen(config.API_PORT, '0.0.0.0', () => app.locals.log.info(`api listening on :${config.API_PORT}`));
configureServer(server);

// SIGINT/SIGTERM: /ready vira 503, fecha o servidor, espera a ingestao corrente (worker.stop) e so entao fecha fila e banco.
const shutdown = gracefulShutdown({ app, server, stop: () => worker?.stop(), close: async () => { await queue.close(); await db.close(); } });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    app.locals.log.info({ sig }, 'shutting down');
    setTimeout(() => process.exit(1), 30_000).unref(); // trava de seguranca
    shutdown().then(() => process.exit(0), (e) => { app.locals.log.error({ err: e }, 'shutdown failed'); process.exit(1); });
  });
}
