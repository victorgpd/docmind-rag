import type { ChatMessage } from '@docmind/llm';
import { delimitPassages } from '@docmind/retrieval';

/**
 * Prompt com os trechos como DADO nao confiavel (nonce, escape de [n], linha unica: delimitPassages do retrieval).
 * O prompt numera 1..k pela posicao; `relabel` reescreve os [i] da resposta para o n global de citacao do agente.
 */
export function groundedMessages(task: string, passages: { n: number; snippet: string }[], question?: string) {
  const { instruction, block } = delimitPassages(passages.map((p) => p.snippet));
  const q = question ? `\n\nPergunta: ${question.replace(/\s+/g, ' ').trim()}` : '';
  const messages: ChatMessage[] = [
    { role: 'system', content: `${task}\n${instruction}` },
    { role: 'user', content: `${block}${q}` },
  ];
  // passagem unica, para que a troca nao encadeie (ex.: [1]->[2] e depois [2]->[3])
  const relabel = (text: string) => text.replace(/\[(\d+)\]/g, (m, i: string) => (passages[+i - 1] ? `[${passages[+i - 1]!.n}]` : m));
  return { messages, relabel };
}
