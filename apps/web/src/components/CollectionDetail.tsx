'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import type { Collection, Document } from '@docmind/shared';
import { api, errorMessage } from '../lib/api';
import { DEMO_HINT, useAuth } from '../lib/auth';
import { useDocuments } from '../lib/useDocuments';
import { DocumentList } from './DocumentList';
import { FormField } from './FormField';
import { UploadZone } from './UploadZone';
import { Button, Input, PageHeader, Skeleton, useToast } from './ui';

function isHttpUrl(v: string) {
  try {
    return /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
}

export function CollectionDetail({ id }: { id: string }) {
  const [notify, toast] = useToast();
  const [urlError, setUrlError] = useState('');
  const [collection, setCollection] = useState<Collection | null>(null);
  const {
    documents,
    hasMore,
    loadingMore,
    loadMore,
    error: loadError,
    add,
    remove,
  } = useDocuments(id);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const { demo } = useAuth();

  useEffect(() => {
    api
      .getCollection(id)
      .then(setCollection)
      .catch((e) => setErrors([errorMessage(e)]));
  }, [id]);

  const fail = (what: string, e: unknown) =>
    setErrors((l) => [...l, `${what}: ${errorMessage(e)}`]);

  async function upload(files: File[]) {
    setBusy(true);
    setErrors([]);
    let sent = 0;
    for (const f of files) {
      try {
        add(await api.uploadDocument(id, f));
        sent++;
      } catch (e) {
        fail(f.name, e);
      }
    }
    if (sent) notify(sent === 1 ? 'Documento enviado' : `${sent} documentos enviados`);
    setBusy(false);
  }

  async function importUrl(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const url = String(new FormData(form).get('url') ?? '').trim();
    if (!url) return setUrlError('Informe a URL do documento.');
    if (!isHttpUrl(url)) return setUrlError('Informe uma URL válida, começando com http:// ou https://.');
    setUrlError('');
    setErrors([]);
    setImporting(true);
    try {
      add(await api.importDocument(id, url));
      form.reset();
      notify('Importação iniciada');
    } catch (err) {
      fail(url, err);
    } finally {
      setImporting(false);
    }
  }

  async function del(d: Document) {
    try {
      await api.deleteDocument(d.id);
      remove(d.id);
    } catch (e) {
      fail(d.filename, e);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {toast}
      <div className="flex flex-col gap-4">
        <Link href="/collections" className="inline-flex items-center gap-1 text-sm !text-muted hover:!text-fg">
          <span aria-hidden>←</span> Coleções
        </Link>
        <PageHeader title={collection?.name ?? 'Coleção'} subtitle={collection?.description} />
      </div>

      <UploadZone onFiles={upload} disabled={busy || demo} hint={demo ? DEMO_HINT : undefined} />

      <form onSubmit={importUrl} noValidate aria-label="Importar por URL" className="card p-5">
        <FormField id="import-url" label="Importar por URL" error={urlError}>
          {(c) => (
            <div className="flex gap-2">
              <Input name="url" type="url" placeholder="https://…" {...c} />
              <Button variant="primary" type="submit" disabled={importing || demo} aria-busy={importing} title={demo ? DEMO_HINT : undefined}>
                Importar
              </Button>
            </div>
          )}
        </FormField>
      </form>

      <div aria-live="polite">
        {[loadError, ...errors].filter(Boolean).map((m) => (
          <p key={m} role="alert" className="text-sm text-danger">
            {m}
          </p>
        ))}
      </div>

      <section aria-labelledby="docs-h" className="flex flex-col gap-3">
        <h2 id="docs-h" className="text-base font-semibold">
          Documentos
        </h2>
        {documents === null ? (
          <Skeleton />
        ) : (
          <DocumentList
            documents={documents}
            onDelete={del}
            disabledReason={demo ? DEMO_HINT : undefined}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
          />
        )}
      </section>
    </div>
  );
}
