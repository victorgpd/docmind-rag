import type { ChatMessage } from '@docmind/llm';
import { CitationFilter, delimitPassages } from '@docmind/retrieval';

/**
 * Prompt com os trechos como DADO nao confiavel (nonce, escape de [n], linha unica: delimitPassages do retrieval).
 * O prompt numera 1..k pela posicao; `relabel` remove [i] fora de 1..k (CitationFilter, o mesmo do chat) e reescreve os validos para o n global de citacao do agente.
 */
export function groundedMessages(task: string, passages: { n: number; snippet: string }[], question?: string) {
  const { instruction, block } = delimitPassages(passages.map((p) => p.snippet));
  const q = question ? `\n\nPergunta: ${question.replace(/\s+/g, ' ').trim()}` : '';
  const messages: ChatMessage[] = [
    { role: 'system', content: `${task}\n${instruction}` },
    { role: 'user', content: `${block}${q}` },
  ];
  // filtro primeiro (um "[9]" inventado nao chega ao usuario); troca em passagem unica, para nao encadear ([1]->[2] e depois [2]->[3])
  const relabel = (text: string) => {
    const f = new CitationFilter(passages.length);
    return (f.push(text) + f.flush()).replace(/\[(\d+)\]/g, (_m, i: string) => `[${passages[+i - 1]!.n}]`);
  };
  return { messages, relabel };
}
