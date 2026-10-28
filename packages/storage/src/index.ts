import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

export interface Storage {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export class FsStorage implements Storage {
  constructor(private root: string) {}
  private path(key: string) {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, data: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    return new Uint8Array(await readFile(this.path(key)));
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

/** S3/MinIO (path-style, exigido pelo MinIO). */
export class S3Storage implements Storage {
  constructor(private client: S3Client, private bucket: string) {}
  async put(key: string, data: Uint8Array) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }
  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return r.Body!.transformToByteArray();
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export interface StorageOptions {
  dir: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Region?: string;
}

/** s3Endpoint setado => S3/MinIO (bucket e credenciais, se omitidos, vem de S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY); senao filesystem. */
export function createStorage(opts: StorageOptions): Storage {
  if (!opts.s3Endpoint) return new FsStorage(opts.dir);
  const bucket = opts.s3Bucket || process.env.S3_BUCKET;
  const accessKeyId = opts.s3AccessKey || process.env.S3_ACCESS_KEY;
  const secretAccessKey = opts.s3SecretKey || process.env.S3_SECRET_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) throw new Error('S3 storage requires bucket, access key and secret key');
  const client = new S3Client({
    endpoint: opts.s3Endpoint,
    region: opts.s3Region ?? 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return new S3Storage(client, bucket);
}
