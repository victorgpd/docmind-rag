'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type ThemeState = { dark: boolean; toggle: () => void };
const ThemeContext = createContext<ThemeState | null>(null);

/** Roda antes da hidratacao (sem cookie, segue prefers-color-scheme) para a classe `dark` nao piscar. */
export const themeInitScript = `try{var m=document.cookie.match(/docmind_theme=(dark|light)/),t=m&&m[1];if(t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark')}catch(e){}`;

/**
 * Tema claro/escuro por CSS vars (classe `dark` no <html>); o antd (Modal/Drawer) le essa classe ao abrir.
 * `initialDark` vem do cookie lido no servidor; sem cookie vale o que o script acima decidiu.
 */
export function ThemeProvider({ initialDark, children }: { initialDark?: boolean; children: ReactNode }) {
  const [dark, setDark] = useState(initialDark ?? false);

  useEffect(() => {
    if (initialDark === undefined) setDark(document.documentElement.classList.contains('dark'));
  }, [initialDark]);

  const toggle = useCallback(() => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    document.cookie = `docmind_theme=${next ? 'dark' : 'light'}; path=/; max-age=31536000; samesite=lax`;
    setDark(next);
  }, [dark]);

  const value = useMemo(() => ({ dark, toggle }), [dark, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme fora do ThemeProvider');
  return ctx;
}
