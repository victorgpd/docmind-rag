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
  it('handler que rejeita repete com a politica do BullQueue (3 tentativas, backoff 1 s e 2 s); o que resolve nao repete', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const q = new MemoryQueue();
      let fails = 0;
      const ok = vi.fn(async () => {});
      q.process('falha', async () => {
        fails++;
        throw new Error('banco fora');
      });
      q.process('ok', ok);
      await q.enqueue('falha', 1);
      await q.enqueue('ok', 1);
      await vi.advanceTimersByTimeAsync(0);
      expect([fails, ok.mock.calls.length]).toEqual([1, 1]);
      await vi.advanceTimersByTimeAsync(999);
      expect(fails).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fails).toBe(2); // 1 s depois
      await vi.advanceTimersByTimeAsync(2000);
      expect(fails).toBe(3); // mais 2 s
      await vi.advanceTimersByTimeAsync(60_000);
      expect([fails, ok.mock.calls.length]).toEqual([3, 1]); // desiste na 3a e registra
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
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
    expect(added[0]![2]).toMatchObject({ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }); // a mesma do MemoryQueue
    await workers[0]!.fn({ data: { id: 1 } });
    expect(handler).toHaveBeenCalledWith({ id: 1 });
    handler.mockRejectedValueOnce(new Error('banco fora'));
    await expect(workers[0]!.fn({ data: { id: 2 } })).rejects.toThrow('banco fora'); // a rejeicao chega ao BullMQ, que entao repete
    await q.close();
  });
});
