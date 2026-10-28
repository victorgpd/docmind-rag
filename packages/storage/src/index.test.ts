import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsStorage, S3Storage, createStorage, type Storage } from './index';

const bytes = new TextEncoder().encode('ola');

/** Contrato comum a qualquer Storage. */
function contract(make: () => Promise<{ s: Storage; done?: () => Promise<void> }>) {
  it('put/get/delete', async () => {
    const { s, done } = await make();
    await s.put('org/doc/a.txt', bytes);
    expect(await s.get('org/doc/a.txt')).toEqual(bytes);
    await s.delete('org/doc/a.txt');
    await expect(s.get('org/doc/a.txt')).rejects.toThrow();
    await done?.();
  });
}

describe('FsStorage', () => {
  contract(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-'));
    return { s: new FsStorage(dir), done: () => rm(dir, { recursive: true, force: true }) };
  });
  it('rejeita path traversal', async () => {
    await expect(new FsStorage('/tmp/x').put('../evil', bytes)).rejects.toThrow('invalid storage key');
  });
});

describe('S3Storage (cliente fake em memoria)', () => {
  contract(async () => {
    const objs = new Map<string, Uint8Array>();
    const client: any = {
      send: async (cmd: any) => {
        const { Key, Body } = cmd.input;
        switch (cmd.constructor.name) {
          case 'PutObjectCommand': objs.set(Key, Body); return {};
          case 'DeleteObjectCommand': objs.delete(Key); return {};
          default: {
            const v = objs.get(Key);
            if (!v) throw new Error('NoSuchKey');
            return { Body: { transformToByteArray: async () => v } };
          }
        }
      },
    };
    return { s: new S3Storage(client, 'b') };
  });
});

describe('createStorage', () => {
  it('filesystem sem endpoint; S3 com endpoint e credenciais; erro se faltar bucket', () => {
    expect(createStorage({ dir: '/tmp/x' })).toBeInstanceOf(FsStorage);
    const o = { dir: '/tmp/x', s3Endpoint: 'http://m:9000' };
    expect(createStorage({ ...o, s3Bucket: 'b', s3AccessKey: 'k', s3SecretKey: 's' })).toBeInstanceOf(S3Storage);
    expect(() => createStorage(o)).toThrow(/bucket/);
  });
});
