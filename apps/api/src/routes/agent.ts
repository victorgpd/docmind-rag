import { AgentRequestSchema } from '@docmind/agent';
import { Router } from 'express';
import type { Deps } from '../app';
import { authenticate, withOrg } from '../http/auth';
import { openSse } from '../http/sse';
import { validate } from '../http/validate';
import { assertWithinLimit, createAgentRunner, type AgentRequest, type AgentRunnerOpts } from './agent-run';
import { assertWithinGlobalLimit } from './usage';

export type AgentRouterOpts = AgentRunnerOpts;

/** POST /agent/run -> SSE (plan, step, step_result, result | error). A execucao e a mesma do chat em modo agente (agent-run.ts). */
export function agentRouter(deps: Deps, opts: AgentRouterOpts = {}) {
  const r = Router();
  const runner = createAgentRunner(deps, opts);

  r.post('/agent/run', authenticate, validate({ body: AgentRequestSchema }), async (req, res) => {
    // falhas com status HTTP acontecem antes de abrir o stream, como no chat
    await assertWithinGlobalLimit(deps);
    await withOrg(req, (tx) => assertWithinLimit(tx, deps));
    const s = openSse(res);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      for await (const e of runner.run(req, req.body as AgentRequest, abort.signal)) s.send(e.type, e);
    } catch (err) {
      req.log.error({ err }, 'agent failed'); // headers ja enviados: erro vai como evento SSE
      s.send('error', { type: 'error', message: 'Agent failed' });
    } finally {
      s.end();
    }
  });

  return r;
}
