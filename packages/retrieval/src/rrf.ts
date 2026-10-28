/** Reciprocal Rank Fusion: score(id) = soma de 1 / (k + posição) em cada lista. */
export function rrf(lists: string[][], k = 60): { id: string; score: number }[] {
  const acc = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => acc.set(id, (acc.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...acc].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
