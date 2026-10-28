import { describe, expect, it, vi } from 'vitest';

const added: unknown[][] = [];
const workers: { name: string; fn: (job: { data: unknown }) => Promise<void> }[] = [];
vi.mock('bullmq', () => ({
  Queue: class {
    add = async (...a: unknown[]) => void added.push(a);
    close = async () => {};
  },
  Worker: class {
    constructor(name: string, fn: any) {
      workers.push({ name, fn });
    }
    on() {}
    close = async () => {};
  },
}));
vi.mock('ioredis', () => ({ Redis: class { disconnect() {} } }));

const { BullQueue, MemoryQueue, createQueue } = await import('./index');

describe('MemoryQueue', () => {
  it('entrega jobs, inclusive os enfileirados antes do handler', async () => {
    const q = new MemoryQueue();
    const got: number[] = [];
    await q.enqueue('a', 1);
    q.process('a', async (p: number) => void got.push(p));
    await q.enqueue('a', 2);
    await new Promise((r) => setImmediate(r));
    expect(got.sort()).toEqual([1, 2]);
  });
});

describe('createQueue', () => {
  it('usa memoria sem redisUrl e BullMQ com redisUrl', () => {
    expect(createQueue()).toBeInstanceOf(MemoryQueue);
    expect(createQueue({ redisUrl: 'redis://x:6379' })).toBeInstanceOf(BullQueue);
  });
});

describe('BullQueue', () => {
  it('enfileira com retry e repassa job.data ao handler', async () => {
    const q = new BullQueue('redis://x:6379');
    const handler = vi.fn(async () => {});
    q.process('ingest', handler);
    await q.enqueue('ingest', { id: 1 });
    expect(added[0]![0]).toBe('ingest');
    expect((added[0]![2] as any).attempts).toBe(3);
    await workers[0]!.fn({ data: { id: 1 } });
    expect(handler).toHaveBeenCalledWith({ id: 1 });
    await q.close();
  });
});
