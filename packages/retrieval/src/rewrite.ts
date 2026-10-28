import { tokenize } from '@docmind/llm';

/**
 * Reescrita local da pergunta com o histórico: follow-up curto ("e o prazo?") herda a última pergunta do usuário.
 * shortcut: heurística sem LLM (zero API externa); com ollama dá para trocar por reescrita generativa.
 */
export function rewriteQuestion(question: string, history: { role: string; content: string }[]): string {
  const prev = [...history].reverse().find((m) => m.role === 'user')?.content;
  return prev && tokenize(question).length <= 4 ? `${prev} ${question}` : question;
}
