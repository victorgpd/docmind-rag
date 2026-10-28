import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { basename } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, collections, desc, documents, eq, sql } from '@docmind/db';
import { isBlockedIp } from '@docmind/ingest';
import { invalidate } from '@docmind/retrieval';
import { HEAD_BYTES, validateUpload } from '@docmind/security';
import { Document, DocumentList, Id, ImportDocumentUrlBody, ListDocumentsPageQuery, ListDocumentsQuery } from '@docmind/shared';
import type { Deps } from '../app';
import { authenticate, withOrg } from '../http/auth';
import { HttpError } from '../http/errors';
import { openSse } from '../http/sse';
import { upload } from '../http/upload';
import { validate } from '../http/validate';
import { assertWithinGlobalLimit } from './usage';

// Espelha INGEST_QUEUE/IngestJob de apps/worker (a API nao depende do pacote worker); manter em sincronia.
const INGEST_QUEUE = 'ingest-document';
type IngestJob = { organizationId: string; documentId: string };

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
} as const;
/** Documento importado por URL: o storage guarda a URL como texto e o worker busca a pagina. */
export const URL_MIME = 'text/x-url';

/**
 * Hub de mudancas de documento. O worker (in-process) chama `notifyDocumentChange` ao mudar o status;
 * os streams SSE reconsultam o banco quando ouvem o evento. O polling cobre worker em outro processo.
 */
export const documentEvents = new EventEmitter().setMaxListeners(0);
let generation = 0; // sobe a cada mudanca: uma consulta iniciada antes dela nunca e reaproveitada depois
export const notifyDocumentChange = (organizationId: string) => {
  generation++;
  documentEvents.emit('change', organizationId);
};

/** Consulta em voo compartilhada entre streams identicos (mesma organizacao, filtro e geracao): N abas = 1 transacao no PGlite. */
const flights = new Map<string, Promise<(typeof documents.$inferSelect)[]>>();
function sharedRows(key: string, run: () => Promise<(typeof documents.$inferSelect)[]>) {
  const k = `${generation}:${key}`;
  let p = flights.get(k);
  if (!p) {
    p = run().finally(() => flights.delete(k));
    flights.set(k, p);
  }
  return p;
}

const IdParam = z.object({ id: Id });
const toDto = (row: typeof documents.$inferSelect) => Document.parse({ ...row, createdAt: row.createdAt.toISOString() });

/** So http(s), sem credenciais, e nada que resolva para IP privado/reservado (isBlockedIp, o mesmo do safe-fetch). O worker valida o IP da conexao: esta checagem so rejeita cedo. */
export async function assertPublicUrl(raw: string) {
  const bad = (msg: string) => new HttpError(400, 'invalid_url', msg);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw bad('invalid url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('only http(s) urls are allowed');
  if (u.username || u.password) throw bad('urls with credentials are not allowed');
  // new URL ja normaliza decimal/hex/octal (http://2130706433/ -> 127.0.0.1)
  const host = u.hostname.replace(/^[|]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw bad('host not found');
  if (addrs.some((a) => isBlockedIp(a.address))) throw bad('url resolves to a private address');
  return u;
}

export function documentsRouter(deps: Deps, opts: { pollMs?: number } = {}) {
  const { storage, queue } = deps;
  // Sem Redis o worker roda neste processo e avisa cada mudanca (documentEvents): o polling e so rede de seguranca.
  // Cada poll e uma transacao no PGlite (uma conexao so) que disputa a vez com o worker; com muitos streams abertos, 1 s por stream atrasa a ingestao.
  const pollMs = opts.pollMs ?? (deps.config.REDIS_URL ? 1000 : 10_000);
  const r = Router();

  const findDoc = async (req: Request, id: string) => {
    const [row] = await withOrg(req, (tx) => tx.select().from(documents).where(eq(documents.id, id)));
    if (!row) throw new HttpError(404, 'not_found', 'document not found');
    return row;
  };

  /** Grava o conteudo e cria o documento (pending); a fila so e acionada em /process. */
  async function createDocument(req: Request, collectionId: string, filename: string, mimeType: string, data: Buffer) {
    const orgId = req.auth.orgId;
    const [coll] = await withOrg(req, (tx) => tx.select({ id: collections.id }).from(collections).where(eq(collections.id, collectionId)));
    if (!coll) throw new HttpError(404, 'collection_not_found', 'collection not found');
    const docId = crypto.randomUUID();
    const storageKey = `${orgId}/${docId}/${filename}`;
    await storage.put(storageKey, data);
    try {
      const [row] = await withOrg(req, (tx) =>
        tx.insert(documents).values({ id: docId, organizationId: orgId, collectionId, filename, mimeType, sizeBytes: data.length, storageKey }).returning(),
      );
      notifyDocumentChange(orgId);
      return toDto(row!);
    } catch (e) {
      await storage.delete(storageKey); // sem orfao no storage
      throw e;
    }
  }

  r.post('/collections/:id/documents', authenticate, validate({ params: IdParam }), upload(MAX_UPLOAD_BYTES).single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'no_file', 'file field is required');
    // basename + whitelist: sem path traversal na chave do storage
    const filename = basename(file.originalname.replace(/\\/g, '/')).replace(/[^\w. -]/g, '_');
    const check = validateUpload({ filename, size: file.buffer.length, head: file.buffer.subarray(0, HEAD_BYTES) }, { maxBytes: MAX_UPLOAD_BYTES });
    if (!check.ok) throw new HttpError(415, 'invalid_file', check.reason);
    const doc = await createDocument(req, (req.params as z.infer<typeof IdParam>).id, filename, TYPES[check.kind], file.buffer);
    res.status(201).json(doc);
  });

  const importUrl = async (req: Request, res: Response, collectionId: string, rawUrl: string) => {
    const u = await assertPublicUrl(rawUrl);
    const name = `${u.hostname}${u.pathname}`.replace(/[^\w.-]+/g, '_').slice(0, 100) + '.url';
    res.status(201).json(await createDocument(req, collectionId, name, URL_MIME, Buffer.from(u.href)));
  };

  r.post('/collections/:id/documents/import', authenticate, validate({ params: IdParam, body: ImportDocumentUrlBody }), (req, res) =>
    importUrl(req, res, (req.params as z.infer<typeof IdParam>).id, (req.body as ImportDocumentUrlBody).url),
  );
  // alias do contrato original
  r.post('/documents/url', authenticate, validate({ body: ImportDocumentUrlBody.extend({ collectionId: Id }) }), (req, res) =>
    importUrl(req, res, req.body.collectionId, req.body.url),
  );

  r.get('/documents', authenticate, validate({ query: ListDocumentsPageQuery }), async (req, res) => {
    const { collectionId, status, limit, cursor } = req.query as unknown as ListDocumentsPageQuery;
    // shortcut: cursor = id; se o documento do cursor for apagado entre paginas, a proxima pagina vem vazia
    const after = cursor
      ? sql`(${documents.createdAt}, ${documents.id}) < (select created_at, id from documents where id = ${cursor})`
      : undefined;
    const rows = await withOrg(req, (tx) =>
      tx
        .select()
        .from(documents)
        .where(and(collectionId ? eq(documents.collectionId, collectionId) : undefined, status ? eq(documents.status, status) : undefined, after))
        .orderBy(desc(documents.createdAt), desc(documents.id))
        .limit(limit + 1),
    );
    const page = rows.slice(0, limit);
    res.json(DocumentList.parse({ items: page.map(toDto), nextCursor: rows.length > limit ? page[limit - 1]!.id : null }));
  });

  /**
   * SSE de `document` (data = Document completo). Envia o estado atual e depois so o que mudou.
   * Reconsulta o banco no evento do hub e no polling (worker em outro processo). `single` fecha em ready/failed.
   */
  function stream(req: Request, res: Response, where: ReturnType<typeof eq> | undefined, single: boolean, filterKey: string) {
    const s = openSse(res);
    const seen = new Map<string, string>();
    let busy = false;
    let dirty = false;

    const finish = () => {
      clearInterval(timer);
      clearTimeout(coalesce);
      documentEvents.off('change', onChange);
      if (!s.closed) s.end();
    };
    const check = async () => {
      if (busy) return void (dirty = true);
      busy = true;
      try {
        do {
          dirty = false;
          if (s.closed) return finish();
          const rows = await sharedRows(`${req.auth.orgId}:${filterKey}`, () => withOrg(req, (tx) => tx.select().from(documents).where(where)));
          for (const row of rows) {
            const key = `${row.status}|${row.error}`;
            if (seen.get(row.id) === key) continue;
            seen.set(row.id, key);
            s.send('document', toDto(row));
          }
          if (single && (!rows[0] || rows[0].status === 'ready' || rows[0].status === 'failed')) return finish();
        } while (dirty);
      } catch (e) {
        req.log?.error({ err: e }, 'document stream failed');
        finish();
      } finally {
        busy = false;
      }
    };
    // rajadas de eventos (processing, ready, rota) viram uma consulta so
    let coalesce: NodeJS.Timeout | undefined;
    const onChange = (orgId: string) => {
      if (orgId !== req.auth.orgId || coalesce) return;
      coalesce = setTimeout(() => {
        coalesce = undefined;
        void check();
      }, 25);
    };

    documentEvents.on('change', onChange);
    const timer = setInterval(() => void check(), pollMs);
    req.on('close', finish);
    void check();
  }

  // antes de /documents/:id, senao "events" viraria um id
  r.get('/documents/events', authenticate, validate({ query: ListDocumentsQuery }), (req, res) => {
    const { collectionId } = req.query as z.infer<typeof ListDocumentsQuery>;
    stream(req, res, collectionId ? eq(documents.collectionId, collectionId) : undefined, false, `c:${collectionId ?? '*'}`);
  });

  r.get('/documents/:id', authenticate, validate({ params: IdParam }), async (req, res) => {
    res.json(toDto(await findDoc(req, (req.params as z.infer<typeof IdParam>).id)));
  });

  r.get('/documents/:id/events', authenticate, validate({ params: IdParam }), async (req, res) => {
    const doc = await findDoc(req, (req.params as z.infer<typeof IdParam>).id); // 404 antes de abrir o stream
    stream(req, res, eq(documents.id, doc.id), true, `d:${doc.id}`);
  });

  r.post('/documents/:id/process', authenticate, validate({ params: IdParam }), async (req, res) => {
    const row = await findDoc(req, (req.params as z.infer<typeof IdParam>).id);
    // so pending (primeira vez) ou failed (retry); evita ingestao duplicada
    if (row.status === 'processing' || row.status === 'ready') throw new HttpError(409, 'invalid_state', `document is already ${row.status}`);
    await assertWithinGlobalLimit(deps); // embeddings tambem custam
    const [updated] = await withOrg(req, (tx) => tx.update(documents).set({ status: 'pending', error: null }).where(eq(documents.id, row.id)).returning());
    await queue.enqueue<IngestJob>(INGEST_QUEUE, { organizationId: req.auth.orgId, documentId: row.id });
    notifyDocumentChange(req.auth.orgId);
    res.status(202).json(toDto(updated!));
  });

  r.delete('/documents/:id', authenticate, validate({ params: IdParam }), async (req, res) => {
    const row = await findDoc(req, (req.params as z.infer<typeof IdParam>).id);
    await withOrg(req, (tx) => tx.delete(documents).where(eq(documents.id, row.id))); // chunks em cascata
    await storage.delete(row.storageKey);
    invalidate({ organizationId: req.auth.orgId, collectionId: row.collectionId }); // cache semantico nao pode citar documento apagado
    notifyDocumentChange(req.auth.orgId);
    res.status(204).end();
  });

  return r;
}
