'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Collection } from '@docmind/shared';
import { api, errorMessage } from '../lib/api';
import { DEMO_HINT, useAuth } from '../lib/auth';
import { FolderIcon, PencilIcon, PlusIcon, TrashIcon } from './icons';
import { Button, Empty, PageHeader, Skeleton, useToast } from './ui';

// Dialogs (Modal do antd + formulario) so carregam no primeiro clique: fora do bundle inicial da rota.
const CollectionModal = dynamic(() => import('./CollectionModal').then((m) => m.CollectionModal));
const ConfirmDeleteModal = dynamic(() => import('./CollectionModal').then((m) => m.ConfirmDeleteModal));

type Dialog = { kind: 'edit'; collection: Collection | null } | { kind: 'delete'; collection: Collection };

export const iconButton =
  'inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-40';

export function CollectionsView() {
  const [notify, toast] = useToast();
  const [items, setItems] = useState<Collection[] | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const { demo } = useAuth();
  const readOnly = demo ? { disabled: true, title: DEMO_HINT } : {};

  const load = useCallback(() => {
    api.listCollections().then(setItems).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  async function remove(c: Collection) {
    try {
      await api.deleteCollection(c.id);
      setDialog(null);
      notify('Coleção excluída');
      load();
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }

  const create = (
    <Button variant="primary" onClick={() => setDialog({ kind: 'edit', collection: null })} {...readOnly}>
      <PlusIcon size={16} />
      Nova coleção
    </Button>
  );

  return (
    <div className="flex flex-col gap-8">
      {toast}
      <PageHeader title="Coleções" subtitle="Agrupe seus documentos e pergunte a eles no chat." actions={create} />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {items === null ? (
        <Skeleton />
      ) : items.length === 0 ? (
        <Empty hint="Crie uma coleção, envie documentos e converse com eles.">Nenhuma coleção ainda. Crie a primeira.</Empty>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((c) => (
            <li key={c.id} className="card card-hover group relative flex flex-col gap-3 p-5">
              <span aria-hidden className="flex size-10 items-center justify-center rounded-xl bg-tint text-brand">
                <FolderIcon size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <Link href={`/collections/${c.id}`} className="block truncate font-semibold !text-fg after:absolute after:inset-0 after:rounded-xl">
                  {c.name}
                </Link>
                <p className="mt-1 line-clamp-2 min-h-10 text-sm text-muted">{c.description}</p>
              </div>
              <p className="text-xs text-muted">Criada em {new Date(c.createdAt).toLocaleDateString('pt-BR')}</p>
              <div className="absolute right-3 top-3 z-10 flex gap-0.5 opacity-50 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                <button type="button" className={iconButton} onClick={() => setDialog({ kind: 'edit', collection: c })} aria-label={`Editar ${c.name}`} {...readOnly}>
                  <PencilIcon size={16} />
                </button>
                <button type="button" className={iconButton} onClick={() => setDialog({ kind: 'delete', collection: c })} aria-label={`Excluir ${c.name}`} {...readOnly}>
                  <TrashIcon size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog?.kind === 'edit' && (
        <CollectionModal
          collection={dialog.collection}
          onClose={() => setDialog(null)}
          onSaved={(edited) => {
            setDialog(null);
            notify(edited ? 'Coleção atualizada' : 'Coleção criada');
            load();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDeleteModal collection={dialog.collection} onClose={() => setDialog(null)} onConfirm={() => remove(dialog.collection)} />
      )}
    </div>
  );
}
