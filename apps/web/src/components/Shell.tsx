'use client';

import { Drawer } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { Organization } from '@docmind/shared';
import { api as chatApi, type Usage } from '../features/chat/api';
import { GITHUB_URL } from '../config/site';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ChartIcon, ChatIcon, ChevronsIcon, FolderIcon, GithubIcon, HistoryIcon, Logo, LogoutIcon, MenuIcon } from './icons';
import { ThemeToggle } from './ThemeToggle';
import { Skeleton } from './ui';

type Item = { href: string; label: string; Icon: ComponentType<{ size?: number }> };
const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: 'Espaço de trabalho',
    items: [
      { href: '/collections', label: 'Coleções', Icon: FolderIcon },
      { href: '/chat', label: 'Chat', Icon: ChatIcon },
      { href: '/conversations', label: 'Conversas', Icon: HistoryIcon },
    ],
  },
  { title: 'Conta', items: [{ href: '/usage', label: 'Uso', Icon: ChartIcon }] },
];

const CRUMBS: Record<string, string> = { collections: 'Coleções', chat: 'Chat', conversations: 'Conversas', usage: 'Uso' };

function OrgSwitcher() {
  const { user, switchOrganization } = useAuth();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  useEffect(() => {
    api.listOrganizations().then(setOrgs).catch(() => setOrgs([]));
  }, [user?.organizationId]);
  if (orgs.length < 2) return null;
  return (
    <div className="flex flex-col gap-1 px-3">
      <label htmlFor="org" className="text-xs text-muted">
        Organização
      </label>
      <select
        id="org"
        value={user?.organizationId}
        onChange={(e) => switchOrganization(e.target.value)}
        className="min-h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm"
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Links reais (<a>): papel de link preservado para leitores de tela e E2E (antd Menu o esconde). */
function NavLinks({ path, compact }: { path: string; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      {GROUPS.map((g) => (
        <div key={g.title}>
          <p className={`mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wider text-muted ${compact ? 'sr-only' : ''}`}>{g.title}</p>
          <ul className="flex flex-col gap-0.5">
            {g.items.map(({ href, label, Icon }) => {
              const active = path === href || path.startsWith(`${href}/`);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    title={compact ? label : undefined}
                    aria-current={active ? 'page' : undefined}
                    className={`relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150 before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full ${compact ? 'justify-center' : ''} ${active ? 'bg-tint font-medium !text-brand before:bg-brand' : '!text-muted hover:bg-subtle hover:!text-fg'}`}
                  >
                    <Icon />
                    <span className={compact ? 'sr-only' : ''}>{label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Rodapé da sidebar: avatar com iniciais, e-mail, uso do plano em barra fina e "Sair". */
function UserCard({ compact }: { compact?: boolean }) {
  const { user, logout } = useAuth();
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    chatApi.usage().then(setUsage).catch(() => setUsage(null));
  }, [user?.organizationId]);
  const email = user?.email ?? '';
  const used = usage ? usage.tokensIn + usage.tokensOut : 0;
  const pct = usage?.monthlyTokenLimit ? Math.min(100, Math.round((used / usage.monthlyTokenLimit) * 100)) : null;
  return (
    <div className="card flex flex-col gap-3 p-3">
      <div className={`flex items-center gap-3 ${compact ? 'justify-center' : ''}`}>
        <span aria-hidden className="bg-grad flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-primary-fg">
          {email.slice(0, 2).toUpperCase()}
        </span>
        {!compact && <span className="min-w-0 truncate text-sm">{email}</span>}
      </div>
      {!compact && pct !== null && (
        <div>
          <div role="progressbar" aria-label="Uso mensal de tokens" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 overflow-hidden rounded-full bg-subtle">
            <div className="bg-grad h-full rounded-full" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted">{pct}% do limite mensal</p>
        </div>
      )}
      <button
        type="button"
        onClick={() => logout()}
        aria-label="Sair"
        className={`inline-flex h-8 items-center gap-2 rounded-lg px-2 text-sm text-muted transition-colors duration-150 hover:bg-subtle hover:text-fg ${compact ? 'justify-center' : ''}`}
      >
        <LogoutIcon size={16} />
        {!compact && 'Sair'}
      </button>
    </div>
  );
}

/** Shell autenticado: sidebar colapsável no desktop, gaveta (antd Drawer) no mobile; anônimos vão para /login. */
export function Shell({ children }: { children: ReactNode }) {
  const { status, demo } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (status === 'anon') router.replace('/login');
  }, [status, router]);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    try {
      setCompact(localStorage.getItem('docmind_nav') === 'compact');
    } catch {
      // armazenamento indisponível: segue expandida
    }
  }, []);

  function toggleCompact() {
    setCompact((c) => {
      try {
        localStorage.setItem('docmind_nav', c ? 'full' : 'compact');
      } catch {
        // preferência não persiste; ok
      }
      return !c;
    });
  }

  if (status !== 'authed')
    return (
      <div className="p-8">
        <Skeleton />
      </div>
    );

  const crumb = CRUMBS[path.split('/')[1] ?? ''];

  return (
    <div className="min-h-screen md:flex">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:bg-surface focus:p-2">
        Ir para o conteúdo
      </a>
      <aside className={`sticky top-0 hidden h-screen shrink-0 flex-col gap-6 border-r border-line bg-surface p-3 transition-[width] duration-150 md:flex ${compact ? 'w-[4.5rem]' : 'w-60'}`}>
        <div className={`flex items-center px-1 pt-1 ${compact ? 'justify-center' : 'justify-between'}`}>
          <Logo text={!compact} />
          {!compact && (
            <button type="button" onClick={toggleCompact} aria-label="Recolher menu" className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-fg">
              <ChevronsIcon size={16} />
            </button>
          )}
        </div>
        {compact && (
          <button type="button" onClick={toggleCompact} aria-label="Expandir menu" className="mx-auto inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-fg">
            <ChevronsIcon size={16} flip />
          </button>
        )}
        {!compact && <OrgSwitcher />}
        <nav aria-label="Principal" className="flex-1 overflow-y-auto">
          <NavLinks path={path} compact={compact} />
        </nav>
        <UserCard compact={compact} />
      </aside>

      <Drawer title={<Logo />} placement="left" size={288} open={open} onClose={() => setOpen(false)} id="menu">
        <div className="flex h-full flex-col gap-6">
          <OrgSwitcher />
          <nav aria-label="Principal" className="flex-1">
            <NavLinks path={path} />
          </nav>
          <UserCard />
        </div>
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 border-b border-line bg-bg/80 px-4 backdrop-blur md:px-8">
          <div className="mx-auto flex h-14 w-full max-w-[56rem] items-center gap-3">
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-fg md:hidden"
            aria-label="Menu"
            aria-expanded={open}
            aria-controls="menu"
            onClick={() => setOpen(true)}
          >
            <MenuIcon />
          </button>
          <span className="md:hidden">
            <Logo size={24} />
          </span>
          <p className="hidden text-sm text-muted md:block">
            DocMind{crumb && <span aria-hidden> / </span>}
            {crumb && <span className="font-medium text-fg">{crumb}</span>}
          </p>
          <span className="flex-1" />
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" aria-label="Código no GitHub" className="flex size-9 items-center justify-center rounded-lg !text-muted hover:bg-subtle hover:!text-fg">
            <GithubIcon size={18} />
          </a>
          <ThemeToggle />
          </div>
        </header>
        <main id="conteudo" className="flex-1 px-4 py-8 md:px-8 md:py-10">
          <div className="mx-auto w-full max-w-[56rem]">
            {demo && (
              <p className="mb-6 rounded-lg border border-line bg-tint px-4 py-2.5 text-sm">
                Você está na conta de demonstração (somente leitura). Converse com os documentos de exemplo; para enviar os seus, crie uma conta.
              </p>
            )}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
