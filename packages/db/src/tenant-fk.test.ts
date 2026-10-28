import { expect, it } from 'vitest';
import { chunks, collections, conversations, createDb, documents, eq, messages, organizations, users } from './index';

const code = (e: any) => e?.code ?? e?.cause?.code;

it('FKs compostas impedem referencia entre organizacoes', async () => {
  const h = await createDb({ pgliteDir: ':memory:' });
  await h.migrate();
  const [a, b] = await h.db.insert(organizations).values([{ name: 'A', slug: 'a' }, { name: 'B', slug: 'b' }]).returning();
  const [colB] = await h.db.insert(collections).values({ organizationId: b!.id, name: 'cb' }).returning();
  const [colA] = await h.db.insert(collections).values({ organizationId: a!.id, name: 'ca' }).returning();
  const doc = (organizationId: string, collectionId: string) =>
    h.db.insert(documents).values({ organizationId, collectionId, filename: 'f', mimeType: 'text/plain', sizeBytes: 1, storageKey: 'k' }).returning();

  // conexao crua (ignora RLS): so a FK composta barra
  await expect(doc(a!.id, colB!.id)).rejects.toSatisfy((e) => code(e) === '23503');
  const [docA] = await doc(a!.id, colA!.id);

  await expect(
    h.db.insert(chunks).values({ organizationId: b!.id, documentId: docA!.id, collectionId: colB!.id, ordinal: 0, content: 'x' }),
  ).rejects.toSatisfy((e) => code(e) === '23503');

  const [u] = await h.db.insert(users).values({ organizationId: a!.id, email: 'u@a.test', name: 'u', passwordHash: 'x' }).returning();
  await expect(h.db.insert(conversations).values({ organizationId: a!.id, userId: u!.id, collectionId: colB!.id })).rejects.toSatisfy((e) => code(e) === '23503');
  const [conv] = await h.db.insert(conversations).values({ organizationId: a!.id, userId: u!.id, collectionId: colA!.id }).returning();
  await expect(
    h.db.insert(messages).values({ organizationId: b!.id, conversationId: conv!.id, role: 'user', content: 'oi' }),
  ).rejects.toSatisfy((e) => code(e) === '23503');

  // caminho valido e cascata continuam funcionando
  await h.db.insert(messages).values({ organizationId: a!.id, conversationId: conv!.id, role: 'user', content: 'oi' });
  await h.db.delete(collections).where(eq(collections.id, colA!.id));
  expect(await h.db.select().from(documents).where(eq(documents.id, docA!.id))).toHaveLength(0);
  await h.close();
});
