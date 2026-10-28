import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, getAccessToken } from './api';

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  email: 'a@b.co',
  name: 'A',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe('cliente da API', () => {
  it('em 401 faz refresh uma vez e repete a requisicao com o novo token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'x' } }, 401)) // GET /collections
      .mockResolvedValueOnce(json({ token: 'novo', user })) // POST /auth/refresh
      .mockResolvedValueOnce(json({ items: [] })); // retry
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.listCollections()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/auth/refresh');
    expect(new Headers(fetchMock.mock.calls[2]?.[1].headers).get('authorization')).toBe('Bearer novo');
    expect(getAccessToken()).toBe('novo');
  });

  it('upload cria o documento e depois chama /process', async () => {
    const doc = {
      id: '33333333-3333-4333-8333-333333333333',
      organizationId: user.organizationId,
      collectionId: '44444444-4444-4444-8444-444444444444',
      filename: 'a.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      storageKey: 'k',
      status: 'pending',
      error: null,
      pageCount: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(doc, 201))
      .mockResolvedValueOnce(json({ ...doc, status: 'processing' }, 202));
    vi.stubGlobal('fetch', fetchMock);

    const out = await api.uploadDocument(doc.collectionId, new File(['x'], 'a.txt'));
    expect(fetchMock.mock.calls[1]?.[0]).toContain(`/documents/${doc.id}/process`);
    expect(fetchMock.mock.calls[1]?.[1].method).toBe('POST');
    expect(out.status).toBe('processing');
  });

  it('login com senha errada nao tenta refresh e expoe a mensagem da API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: { code: 'invalid_credentials', message: 'Senha incorreta' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.login({ email: 'a@b.co', password: 'x' })).rejects.toThrow('Senha incorreta');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
