import { loadConfig } from '@docmind/config';
import { createDb } from '@docmind/db';
import { createLLMFromConfig } from '@docmind/llm';
import { createQueue } from '@docmind/queue';
import { createStorage } from '@docmind/storage';
import { ingestOptionsFromConfig, startWorker } from './index';

const config = loadConfig();
if (!config.REDIS_URL) {
  // fila em memoria nao cruza processos e o PGlite aceita um processo por diretorio: sem Redis o worker roda dentro da API
  console.log('[worker] sem REDIS_URL: o worker roda dentro da API (apps/api). Nada a fazer neste processo.');
  process.exit(0);
}
const handle = await createDb({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
await handle.migrate();
const queue = createQueue({ redisUrl: config.REDIS_URL });
// Cache semantico vive na memoria da API: neste processo separado nao ha o que invalidar (invalidateCache fica de fora).
// A API percebe a mudanca pela versao na chave do cache (contagem + max(updated_at) dos documentos; retrieval/answer.ts).
const worker = startWorker(queue, {
  db: handle.db,
  storage: createStorage({ dir: config.STORAGE_DIR, s3Endpoint: config.S3_ENDPOINT }),
  llm: createLLMFromConfig(config), // a chave (OPENAI_API_KEY) so passa por aqui; nunca logue o config inteiro
  ...ingestOptionsFromConfig(config),
  analyzeWhenIdle: handle.kind === 'pglite',
});
console.log(`[worker] aguardando jobs; recuperados: ${await worker.recovered}`);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log(`[worker] ${sig}: esperando jobs em andamento`);
    void worker.stop().then(() => queue.close()).then(() => handle.close()).finally(() => process.exit(0));
  });
}
setInterval(() => {}, 1 << 30); // mantem o processo vivo
