import { Queue as BullMQQueue, Worker } from 'bullmq';
import { Redis as IORedis } from 'ioredis';

export interface Queue {
  enqueue<T = unknown>(name: string, payload: T): Promise<void>;
  process<T = unknown>(name: string, handler: (payload: T) => Promise<void>): void;
  close(): Promise<void>;
  /** Checagem de saude do backend (Redis); ausente em implementacoes sem dependencia externa. */
  ping?(): Promise<void>;
}

/** Fallback em memoria (um unico processo). */
export class MemoryQueue implements Queue {
  private handlers = new Map<string, (p: any) => Promise<void>>();
  private pending = new Map<string, unknown[]>();

  async enqueue(name: string, payload: unknown) {
    const h = this.handlers.get(name);
    if (h) setImmediate(() => void h(payload).catch((e) => console.error(`[queue:${name}]`, e)));
    else this.pending.set(name, [...(this.pending.get(name) ?? []), payload]);
  }
  process(name: string, handler: (p: any) => Promise<void>) {
    this.handlers.set(name, handler);
    for (const p of this.pending.get(name) ?? []) void handler(p);
    this.pending.delete(name);
  }
  async close() {
    this.handlers.clear();
  }
}

/** Redis/BullMQ: um Queue e um Worker por nome; jobs com 3 tentativas e backoff exponencial. */
export class BullQueue implements Queue {
  private conn: IORedis;
  private queues = new Map<string, BullMQQueue>();
  private workers: Worker[] = [];

  constructor(redisUrl: string) {
    this.conn = new IORedis(redisUrl, { maxRetriesPerRequest: null }); // exigido pelo BullMQ
  }
  private queue(name: string) {
    let q = this.queues.get(name);
    if (!q) this.queues.set(name, (q = new BullMQQueue(name, { connection: this.conn })));
    return q;
  }
  async enqueue(name: string, payload: unknown) {
    await this.queue(name).add(name, payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }
  process(name: string, handler: (p: any) => Promise<void>) {
    const w = new Worker(name, (job) => handler(job.data), { connection: this.conn });
    w.on('failed', (job, e) => console.error(`[queue:${name}]`, job?.id, e));
    this.workers.push(w);
  }
  async ping() {
    await this.conn.ping();
  }
  async close() {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.conn.disconnect();
  }
}

/** redisUrl setado => BullMQ; senao memoria. */
export function createQueue(opts: { redisUrl?: string } = {}): Queue {
  return opts.redisUrl ? new BullQueue(opts.redisUrl) : new MemoryQueue();
}
