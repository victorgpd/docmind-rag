'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthResponse, LoginBody, RegisterBody, User } from '@docmind/shared';
import { api, refresh, setSessionExpiredHandler } from './api';

type Status = 'loading' | 'authed' | 'anon';
type AuthState = {
  user: User | null;
  status: Status;
  /** Conta de demonstracao: a UI desabilita as escritas (a API as barra com 403 demo_read_only). */
  demo: boolean;
  login: (b: LoginBody) => Promise<void>;
  startDemo: () => Promise<void>;
  register: (b: RegisterBody) => Promise<void>;
  switchOrganization: (organizationId: string) => Promise<void>;
  logout: () => Promise<void>;
};

/** Tooltip/texto das acoes de escrita desabilitadas na conta de demonstracao. */
export const DEMO_HINT = 'Indisponível na conta de demonstração (somente leitura).';

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [demo, setDemo] = useState(false);

  const set = useCallback((auth: AuthResponse | null) => {
    setUser(auth?.user ?? null);
    setDemo(auth?.demo === true);
    setStatus(auth ? 'authed' : 'anon');
  }, []);

  useEffect(() => {
    // restaura a sessao pelo cookie de refresh
    refresh().then(set);
    setSessionExpiredHandler(() => set(null));
    return () => {
      setSessionExpiredHandler(null);
    };
  }, [set]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      status,
      demo,
      login: async (b) => set(await api.login(b)),
      startDemo: async () => set(await api.demo()),
      register: async (b) => set(await api.register(b)),
      switchOrganization: async (id) => set(await api.switchOrganization(id)),
      logout: async () => {
        await api.logout();
        set(null);
      },
    }),
    [user, status, demo, set],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}
