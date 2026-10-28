function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

/**
 * Cache semântico em memória: perguntas com embedding quase igual (cosseno >= threshold) reusam a resposta.
 * `key` isola tenant/coleção. shortcut: por processo, varredura linear e só TTL para invalidar
 * (documento apagado ainda pode ser citado até expirar); trocar por tabela/Redis ao escalar.
 */
export class SemanticCache<V> {
  private items: { key: string; emb: number[]; value: V; at: number }[] = [];
  constructor(private readonly o = { threshold: 0.97, ttlMs: 10 * 60_000, max: 200 }) {}

  get(key: string, emb: number[], now = Date.now()): V | undefined {
    let best: { score: number; value: V } | undefined;
    for (const it of this.items) {
      if (it.key !== key || now - it.at > this.o.ttlMs) continue;
      const score = cosine(it.emb, emb);
      if (score >= this.o.threshold && (!best || score > best.score)) best = { score, value: it.value };
    }
    return best?.value;
  }

  /** Remove as entradas cujas chaves satisfazem `match`; devolve quantas saíram. */
  clear(match: (key: string) => boolean): number {
    const before = this.items.length;
    this.items = this.items.filter((it) => !match(it.key));
    return before - this.items.length;
  }

  set(key: string, emb: number[], value: V, now = Date.now()): void {
    this.items = this.items.filter((it) => now - it.at <= this.o.ttlMs);
    this.items.push({ key, emb, value, at: now });
    if (this.items.length > this.o.max) this.items.shift();
  }
}
