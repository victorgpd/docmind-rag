/** Etapas do RAG medidas; `http` e a requisicao inteira. */
export type Stage = 'http' | 'rewrite' | 'retrieve' | 'rerank' | 'generate' | (string & {});

type Dist = { count: number; sum: number; max: number };

const add = (d: Dist, v: number) => {
  d.count++;
  d.sum += v;
  d.max = Math.max(d.max, v);
};

/** Metricas em memoria por processo (shortcut: sem percentis, trocar por prom-client se precisar de p95). */
export class Metrics {
  private latency = new Map<string, Dist>();
  private tokens: Dist = { count: 0, sum: 0, max: 0 };
  private feedback = { positive: 0, negative: 0 };

  observeLatency(stage: Stage, ms: number) {
    let d = this.latency.get(stage);
    if (!d) this.latency.set(stage, (d = { count: 0, sum: 0, max: 0 }));
    add(d, ms);
  }

  /** Tokens totais (entrada + saida) de uma resposta. */
  observeTokens(total: number) {
    add(this.tokens, total);
  }

  recordFeedback(positive: boolean) {
    this.feedback[positive ? 'positive' : 'negative']++;
  }

  snapshot() {
    const total = this.feedback.positive + this.feedback.negative;
    return {
      latencyMs: Object.fromEntries(
        [...this.latency].map(([stage, d]) => [stage, { count: d.count, avg: d.sum / d.count, max: d.max }]),
      ),
      tokensPerResponse: { count: this.tokens.count, avg: this.tokens.count ? this.tokens.sum / this.tokens.count : 0 },
      positiveFeedbackRate: total ? this.feedback.positive / total : null,
      feedback: { ...this.feedback },
    };
  }
}
