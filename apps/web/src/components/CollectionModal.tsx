'use client';

import { useState, type FormEvent } from 'react';
import type { Collection } from '@docmind/shared';
import { api, errorMessage } from '../lib/api';
import { FormField } from './FormField';
import { ThemedModal as Modal } from './ThemedOverlays';
import { Input } from './ui';

// Este arquivo inteiro e carregado sob demanda (next/dynamic em CollectionsView), junto com o antd.

/** Criar e renomear compartilham o dialog: `collection` presente = edicao. */
export function CollectionModal({ collection, onClose, onSaved }: { collection: Collection | null; onClose: () => void; onSaved: (edited: boolean) => void }) {
  const [nameError, setNameError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const title = collection ? `Editar ${collection.name}` : 'Nova coleção';

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    const description = String(f.get('description') ?? '').trim();
    if (!name) return setNameError('Informe o nome da coleção.');
    setNameError('');
    setError('');
    setBusy(true);
    try {
      if (collection) await api.updateCollection(collection.id, { name, description });
      else await api.createCollection({ name, ...(description && { description }) });
      onSaved(!!collection);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      title={title}
      okText={collection ? 'Salvar' : 'Criar coleção'}
      cancelText="Cancelar"
      okButtonProps={{ htmlType: 'submit', form: 'collection-form' }}
      confirmLoading={busy}
      onCancel={onClose}
      destroyOnHidden
    >
      <form id="collection-form" onSubmit={save} noValidate aria-label={title} className="flex flex-col gap-4 pt-2">
        <FormField id="collection-name" label={collection ? 'Nome' : 'Nome da coleção'} error={nameError}>
          {(c) => <Input name="name" maxLength={120} defaultValue={collection?.name} autoFocus {...c} />}
        </FormField>
        <FormField id="collection-desc" label={collection ? 'Descrição' : 'Descrição (opcional)'}>
          {(c) => <Input name="description" defaultValue={collection?.description ?? ''} {...c} />}
        </FormField>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** Confirmacao de exclusao: mesmo nome de botao do antigo popconfirm ("Confirmar exclusão"). */
export function ConfirmDeleteModal({ collection, onClose, onConfirm }: { collection: Collection; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      title={`Excluir “${collection.name}” e seus documentos?`}
      okText="Confirmar exclusão"
      cancelText="Cancelar"
      okButtonProps={{ danger: true }}
      confirmLoading={busy}
      onOk={async () => {
        setBusy(true);
        await onConfirm();
        setBusy(false);
      }}
      onCancel={onClose}
      destroyOnHidden
    >
      <p className="text-sm text-muted">Esta ação não pode ser desfeita.</p>
    </Modal>
  );
}
