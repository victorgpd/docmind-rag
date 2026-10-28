import type { Response } from 'express';

/** Abre um stream SSE; devolve send(event, data) e end(). Para o corpo do evento use JSON (ex.: SseEvent de @docmind/shared). */
export function openSse(res: Response, heartbeatMs = 15_000) {
  res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  // comentario SSE periodico: a Cloudflare corta conexoes ~100 s sem dados e o proxy do Next ~30 s; o cliente ignora linhas ": ..."
  const beat = setInterval(() => void (!res.writableEnded && !res.destroyed && res.write(': ping\n\n')), heartbeatMs);
  beat.unref();
  res.once('close', () => clearInterval(beat));
  return {
    send: (event: string, data: unknown) => void res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => {
      clearInterval(beat);
      res.end();
    },
    /** true quando o cliente desconectou; pare de gerar. */
    get closed() {
      return res.writableEnded || res.destroyed;
    },
  };
}
