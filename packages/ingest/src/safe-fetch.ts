import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { IngestError, PermanentError } from './types';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64]] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

/** true para loopback, privado, link-local (inclui metadata 169.254.169.254), CGNAT, multicast e reservados; IPv6 mapeado/NAT64 vale pelo IPv4 embutido. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(bare);
  if (!family) return true; // nao e IP: nega por padrao
  if (family === 6) {
    const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
    if (m) return isBlockedIp(m[1]!);
    // formas hex (::ffff:7f00:1 / 64:ff9b::7f00:1): extrai os 32 bits finais
    const h = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
    if (h) {
      const n = (parseInt(h[1]!, 16) << 16) | parseInt(h[2]!, 16);
      return isBlockedIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
  }
  return blocked.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}

export type SafeFetchOpts = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Injetavel nos testes. */
  lookup?: typeof dnsLookup;
  isBlocked?: (ip: string) => boolean;
};

/**
 * GET anti-SSRF. O IP validado e o mesmo usado na conexao (lookup customizado do socket => sem janela de DNS rebinding),
 * cada redirect e revalidado, o corpo tem teto e a requisicao tem timeout total. Sem Accept-Encoding (nada de bomba de descompressao).
 */
export async function safeFetchText(raw: string, opts: SafeFetchOpts = {}): Promise<string> {
  const { timeoutMs = 15_000, maxBytes = 10 * 1024 * 1024, maxRedirects = 5 } = opts;
  const isBlocked = opts.isBlocked ?? isBlockedIp;
  const lookup = opts.lookup ?? dnsLookup;
  const deadline = Date.now() + timeoutMs;

  const guardedLookup = ((host: string, o: any, cb: any) => {
    lookup(host, { ...o, all: true }, (err: any, addrs: any) => {
      if (err) return cb(err);
      const list: { address: string; family: number }[] = Array.isArray(addrs) ? addrs : [{ address: addrs, family: isIP(addrs) }];
      const bad = list.find((a) => isBlocked(a.address));
      if (bad || !list.length) return cb(new PermanentError('URL resolve para endereco privado ou reservado', 'url_blocked'));
      // all: true foi pedido por nos; devolve no formato que o chamador original pediu
      return o?.all ? cb(null, list) : cb(null, list[0]!.address, list[0]!.family);
    });
  }) as never;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PermanentError('URL invalida', 'url_blocked');
  }

  for (let hop = 0; ; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new PermanentError('Somente URLs http(s) sao aceitas', 'url_blocked');
    if (url.username || url.password) throw new PermanentError('URL com credenciais nao e aceita', 'url_blocked');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isBlocked(host)) throw new PermanentError('URL aponta para endereco privado ou reservado', 'url_blocked'); // IP literal nao passa pelo lookup

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new IngestError('fetch_failed', 'timeout ao baixar a URL');
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, { method: 'GET', lookup: guardedLookup, headers: { 'user-agent': 'DocMindBot/0.1', accept: 'text/html,text/plain,*/*;q=0.5' } }, resolve);
      req.setTimeout(remaining, () => req.destroy(new IngestError('fetch_failed', 'timeout ao baixar a URL')));
      req.on('error', (e) => reject(e instanceof IngestError ? e : new IngestError('fetch_failed', e.message)));
      req.end();
    });

    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new PermanentError('redirects demais', 'fetch_failed');
      url = new URL(res.headers.location, url); // proximo salto e revalidado no topo do loop
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      const msg = `GET ${url.origin}${url.pathname} -> HTTP ${status}`;
      // 4xx (exceto 429) nao melhora com retry
      throw status >= 400 && status < 500 && status !== 429 ? new PermanentError(msg, 'fetch_failed') : new IngestError('fetch_failed', msg);
    }

    const declared = Number(res.headers['content-length']);
    if (declared > maxBytes) {
      res.destroy();
      throw new PermanentError(`Pagina maior que o limite de ${Math.round(maxBytes / 1024 / 1024)} MB`, 'too_large');
    }
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          res.destroy();
          throw new PermanentError(`Pagina maior que o limite de ${Math.round(maxBytes / 1024 / 1024)} MB`, 'too_large');
        }
        parts.push(chunk as Buffer);
      }
    } catch (e) {
      if (e instanceof PermanentError) throw e;
      throw new IngestError('fetch_failed', `falha ao ler o corpo: ${e instanceof Error ? e.message : e}`);
    }
    return new TextDecoder('utf-8').decode(Buffer.concat(parts)); // ja descarta o BOM
  }
}
