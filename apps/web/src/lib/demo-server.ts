const API_URL = process.env.API_URL ?? 'http://localhost:3001';

/** Flag da conta demo lido no servidor (cache ~60 s) para o botão já vir no HTML; undefined = falhou, o cliente decide. */
export async function demoEnabledOnServer(): Promise<boolean | undefined> {
  try {
    const r = await fetch(`${API_URL}/api/v1/auth/demo`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(2000) });
    if (!r.ok) return undefined;
    return ((await r.json()) as { enabled?: boolean }).enabled === true;
  } catch {
    return undefined;
  }
}
