import type { Server } from 'node:http';
import type { Express } from 'express';

/**
 * Timeouts do servidor HTTP. keepAlive acima dos 60 s tipicos de balanceadores (evita 502 em conexao reaproveitada);
 * headersTimeout > keepAlive; requestTimeout limita so o RECEBIMENTO do request (uploads de ate 25 MB),
 * nao a resposta: SSE continua aberto. server.timeout = 0 (sem timeout de socket ocioso) mantem o stream vivo.
 */
export function configureServer(server: Server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;
  server.timeout = 0;
}

/**
 * Encerramento gracioso: marca /ready como 503, para de aceitar conexoes, fecha as ociosas, da `graceMs` para
 * requests em andamento terminarem (derruba SSE/atrasados depois), aguarda `stop` (worker) e so entao `close` (db, fila).
 */
export function gracefulShutdown(o: { app: Express; server: Server; stop?: () => Promise<unknown> | unknown; close: () => Promise<unknown>; graceMs?: number }) {
  let running: Promise<void> | undefined;
  return () =>
    (running ??= (async () => {
      o.app.locals.closing = true;
      const closed = new Promise<void>((r) => o.server.close(() => r()));
      o.server.closeIdleConnections();
      const timer = setTimeout(() => o.server.closeAllConnections(), o.graceMs ?? 10_000);
      await closed;
      clearTimeout(timer);
      await o.stop?.();
      await o.close();
    })());
}
