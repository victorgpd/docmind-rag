import { loadConfig } from '@docmind/config';
import { createDb, documents, eq } from '@docmind/db';
import { createLLMFromConfig } from '@docmind/llm';
import { createStorage } from '@docmind/storage';
import { ingestOptionsFromConfig, reindexDocuments } from './index';

// Reembeda todos os documentos ja processados (ex.: apos mudar o modelo/tokenizer de embedding).
// Pare a API antes: PGlite aceita um unico processo por diretorio.
const config = loadConfig();
const handle = await createDb({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
await handle.migrate();
const deps = {
  db: handle.db,
  storage: createStorage({ dir: config.STORAGE_DIR, s3Endpoint: config.S3_ENDPOINT }),
  llm: createLLMFromConfig(config),
  ...ingestOptionsFromConfig(config), // mesmos limites e opt-in de contexto da ingestao normal
  globalTokenLimit: 0, // acao do operador (com --yes no provedor externo): o teto global marcaria documentos ready como failed
};
const docs = await handle.db.select({ id: documents.id, organizationId: documents.organizationId }).from(documents).where(eq(documents.status, 'ready'));
console.log(`[reindex] provider=${deps.llm.name} embedding=${deps.llm.embeddingModel} documentos=${docs.length}`);
if (!docs.length) {
  console.log('[reindex] nenhum documento ready: nada a reindexar.');
  await handle.close();
  process.exit(0);
}
// providers externos enviam o texto dos documentos e custam tokens: exige confirmação explícita
if (deps.llm.name !== 'local' && deps.llm.name !== 'ollama' && !process.argv.includes('--yes')) {
  console.log('[reindex] provider externo: rode "pnpm reindex --yes" para confirmar o envio de todos os documentos e o custo de embeddings.');
  await handle.close();
  process.exit(1);
}
await reindexDocuments(deps, (done, total, id) => console.log(`[reindex] ${done}/${total} ${id}`));
await handle.close();
