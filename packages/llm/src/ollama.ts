import type { z } from 'zod';
import { DIMS } from './embed';
import { extractJson } from './text';
import type { ChatMessage, LLMProvider } from './types';

/** Provider opcional via HTTP local (Ollama). O modelo de embedding precisa devolver 384 dims (ex.: all-minilm). */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly dims = DIMS;
  get embeddingModel() {
    return `ollama:${this.embedModel}:${DIMS}`;
  }
  constructor(
    private url: string,
    private model: string,
    private embedModel: string,
  ) {}

  private async post(path: string, body: unknown) {
    const r = await fetch(`${this.url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ollama ${path} ${r.status}`);
    return r;
  }

  async embed(texts: string[]) {
    const { embeddings } = (await (await this.post('/api/embed', { model: this.embedModel, input: texts })).json()) as {
      embeddings: number[][];
    };
    if (embeddings.some((e) => e.length !== this.dims))
      throw new Error(`ollama embed model "${this.embedModel}" must return ${this.dims} dims (try all-minilm)`);
    return embeddings;
  }

  async *generateStream(messages: ChatMessage[]): AsyncIterable<string> {
    const r = await this.post('/api/chat', { model: this.model, messages, stream: true });
    if (!r.body) throw new Error('ollama chat: empty body');
    const dec = new TextDecoder();
    let buf = '';
    const parse = (l: string) => (JSON.parse(l) as { message?: { content?: string } }).message?.content ?? '';
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const l of lines) if (l.trim()) yield parse(l);
    }
    if (buf.trim()) yield parse(buf);
  }

  async generateObject<T>(schema: z.ZodType<T>, messages: ChatMessage[]): Promise<T> {
    let out = '';
    for await (const c of this.generateStream([
      ...messages,
      { role: 'user', content: 'Responda somente com JSON válido.' },
    ]))
      out += c;
    return schema.parse(extractJson(out));
  }
}
