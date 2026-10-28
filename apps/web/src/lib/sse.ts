export type SseMessage = { event: string; data: string };

/** Parser incremental de text/event-stream. Retorna `feed(chunk)`.
 *  shortcut: um "\r" no fim de um chunk e o "\n" no proximo viram linha em branco extra; raro, trocar se o proxy fragmentar assim. */
export function createSseParser(onMessage: (m: SseMessage) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk.replace(/\r\n?/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const [field, ...rest] = line.split(':');
        const value = rest.join(':').replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) onMessage({ event, data: data.join('\n') });
    }
  };
}
