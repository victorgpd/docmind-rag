import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import { DemoButton } from './DemoButton';
import { BoltIcon, Logo, QuoteIcon, ShieldIcon, SparkIcon } from './icons';
import { ThemeToggle } from './ThemeToggle';

// Landing pública: HTML/CSS puro (sem antd, sem imagens), gradiente radial e grade pontilhada em CSS.

const cta = 'inline-flex h-11 items-center justify-center rounded-lg px-5 text-sm font-medium transition duration-150';

const FEATURES: { title: string; text: string; Icon: ComponentType<{ size?: number }> }[] = [
  { title: 'Citações verificáveis', text: 'Cada resposta traz as fontes: clique em [1] e veja o trecho exato do documento.', Icon: QuoteIcon },
  { title: 'Multi-organização e segurança', text: 'Dados isolados por organização, sessão protegida e nada de chaves no navegador.', Icon: ShieldIcon },
  { title: 'Modo agente', text: 'Para perguntas maiores, o agente pesquisa em etapas e mostra cada passo.', Icon: SparkIcon },
  { title: 'Rápido e leve', text: 'Páginas pequenas, respostas em streaming e processamento em segundo plano.', Icon: BoltIcon },
];

const STEPS = [
  { n: '1', title: 'Envie', text: 'Arraste PDFs, textos ou importe por URL para uma coleção.' },
  { n: '2', title: 'Pergunte', text: 'Converse em português com o conteúdo da coleção.' },
  { n: '3', title: 'Confira', text: 'Abra a fonte de cada citação e valide a resposta.' },
];

function Mockup(): ReactNode {
  return (
    <div className="card mx-auto w-full max-w-xl p-5 text-left shadow-[var(--shadow-lift)]" role="img" aria-label="Exemplo de conversa: pergunta sobre férias e resposta com citação da fonte">
      <div className="ml-auto w-fit max-w-[85%] rounded-xl bg-tint px-4 py-2.5 text-sm">Quantos dias de férias eu tenho?</div>
      <div className="mt-4 text-sm leading-relaxed">
        A política permite <strong>30 dias corridos</strong> por ano, com pedido feito 30 dias antes ao gestor <span className="inline-flex rounded-md bg-tint px-1.5 text-xs font-semibold text-brand">[1]</span>.
      </div>
      <div className="mt-4 rounded-lg border border-line bg-bg p-3">
        <p className="text-xs font-medium text-muted">Fonte [1] · politica-de-ferias.txt</p>
        <p className="mt-1 text-xs italic text-muted">“…permite 30 dias corridos por ano. O pedido deve ser feito com 30 dias de antecedência…”</p>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <div className="relative min-h-screen overflow-x-clip bg-bg text-fg">
      <div aria-hidden className="dots pointer-events-none absolute inset-x-0 top-0 h-[34rem] opacity-60 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[34rem] bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,var(--tint),transparent)]" />

      <header className="relative mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
        <Logo />
        <nav aria-label="Acesso" className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/login" className={`${cta} h-9 !text-fg hover:bg-subtle`}>
            Entrar
          </Link>
          <Link href="/register" className={`${cta} bg-grad h-9 !text-primary-fg hover:brightness-110`}>
            Criar conta
          </Link>
        </nav>
      </header>

      <main className="relative">
        <section className="mx-auto max-w-3xl px-5 pb-16 pt-14 text-center sm:pt-20">
          <p className="mx-auto mb-5 w-fit rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-muted">Perguntas e respostas sobre seus documentos</p>
          <h1 className="text-balance text-4xl leading-[1.1] sm:text-6xl">
            Pergunte aos seus documentos. <span className="text-grad">Com fontes.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-pretty text-base text-muted sm:text-lg">
            Envie seus arquivos, converse em português e receba respostas com citações que você pode conferir em um clique.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/login" className={`${cta} bg-grad !text-primary-fg hover:brightness-110`}>
              Entrar
            </Link>
            <Link href="/register" className={`${cta} border border-line-strong bg-surface !text-fg hover:bg-subtle`}>
              Criar conta
            </Link>
            <DemoButton className={`${cta} border border-line-strong bg-surface text-fg hover:bg-subtle`} />
          </div>
        </section>

        <section aria-label="Exemplo" className="px-5 pb-20">
          <Mockup />
        </section>

        <section aria-labelledby="dif" className="mx-auto max-w-5xl px-5 pb-20">
          <h2 id="dif" className="mb-8 text-center text-2xl sm:text-3xl">
            Feito para respostas confiáveis
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {FEATURES.map(({ title, text, Icon }) => (
              <li key={title} className="card card-hover p-5">
                <span aria-hidden className="mb-3 flex size-10 items-center justify-center rounded-xl bg-tint text-brand">
                  <Icon size={20} />
                </span>
                <h3 className="text-base">{title}</h3>
                <p className="mt-1 text-sm text-muted">{text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="como" className="mx-auto max-w-5xl px-5 pb-24">
          <h2 id="como" className="mb-8 text-center text-2xl sm:text-3xl">
            Como funciona
          </h2>
          <ol className="grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="rounded-xl border border-line bg-surface/60 p-5">
                <span aria-hidden className="bg-grad mb-3 flex size-8 items-center justify-center rounded-full text-sm font-semibold text-primary-fg">
                  {s.n}
                </span>
                <h3 className="text-base">{s.title}</h3>
                <p className="mt-1 text-sm text-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="relative border-t border-line">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-muted">
          <Logo size={22} />
          <p>© {new Date().getFullYear()} DocMind. Respostas com fontes.</p>
        </div>
      </footer>
    </div>
  );
}
