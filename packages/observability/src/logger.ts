import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Logs Pino com `reqId` em cada linha (`req.log`); usa o x-request-id recebido ou gera UUID e o devolve no header. */
export function requestLogging(opts: { level?: string; stream?: { write(msg: string): void } } = {}): RequestHandler {
  return pinoHttp(
    {
      level: opts.level ?? 'info',
      // segredos nunca vao para o log
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      genReqId: (req, res) => {
        const given = req.headers[REQUEST_ID_HEADER];
        const id = typeof given === 'string' && given ? given : randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
    },
    opts.stream,
  );
}
