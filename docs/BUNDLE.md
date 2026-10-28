# Bundle do web (First Load JS)

Medido com `NEXT_DIST_DIR=.next-bundle next build` (Next 15.5.28, produção) em `apps/web`. "First Load JS" é o que o navegador baixa para renderizar a rota pela primeira vez (inclui os chunks compartilhados).

## Baseline: antes do Ant Design

| Rota | Size | First Load JS |
|---|---|---|
| `/` | 123 B | 103 kB |
| `/_not-found` | 991 B | 104 kB |
| `/chat` | 3.36 kB | 142 kB |
| `/collections` | 4.42 kB | 139 kB |
| `/collections/[id]` | 5.63 kB | 140 kB |
| `/conversations` | 810 B | 139 kB |
| `/login` | 1.28 kB | 139 kB |
| `/register` | 1.28 kB | 139 kB |
| `/usage` | 1.03 kB | 136 kB |
| **Compartilhado por todas** | | **103 kB** |

`.next/static` (28 arquivos `.js`/`.css`): 998.8 kB brutos, **≈ 314.6 kB com gzip** (nível 6, aproximação do que o servidor envia).

## Versão atual (v2: visual com identidade, Inter, landing)

Mesmo comando; valores da tabela do `next build`. Orçamento: +30 kB por rota sobre a v1 e landing ≤ 120 kB.

| Rota | Baseline | Nativa | v1 (antd Layout/List) | v2 atual |
|---|---|---|---|---|
| `/` (landing, nova) | 103 kB | n/a | n/a | 110 kB |
| `/login`, `/register` | 139 kB | 111 kB | 111 kB | 113 kB |
| `/collections` | 139 kB | 111 kB | 162 kB | 113 kB |
| `/collections/[id]` | 140 kB | 112 kB | 163 kB | 114 kB |
| `/chat` | 142 kB | 113 kB | 166 kB | 117 kB |
| `/conversations` | 139 kB | 110 kB | 161 kB | 113 kB |
| `/usage` | 136 kB | 107 kB | 158 kB | 110 kB |

A v2 ficou abaixo da v1 porque o shell deixou de usar `Layout`/`Sider`/`Button`/`Empty`/`List` do antd: sidebar, cards, pills e ícones são HTML/CSS/SVG inline (custo zero). O antd ficou em `Drawer` (menu mobile), `Modal` (coleções) e `Table` dinâmica (chat). Gradientes, sombras e raios são CSS puro. A fonte Inter variável (subset latin, ~48 kB woff2) é carregada à parte, `font-display: swap`, fora do First Load JS.

Arquitetura anterior (v1) e estágios intermediários seguem abaixo para registro.

## Histórico: v1, login nativo, app autenticado em antd ("Equilibrado")

Mesmo comando. Decisão do usuário: antd no app autenticado, login/cadastro nativos; orçamento de ~+70 kB por rota autenticada sobre o estado nativo anterior (First Load ≈ 160–210 kB). Colunas: baseline (sem antd, nativo do início) → versão nativa (primeiro redesign, só Modal/Drawer em antd) → atual. Valores da tabela do `next build`.

| Rota | Baseline | Nativa | Atual | Delta vs nativa |
|---|---|---|---|---|
| `/login`, `/register` | 139 kB | 111 kB | 111 kB | 0 (sem antd) |
| `/collections` | 139 kB | 111 kB | 162 kB | +51 kB |
| `/collections/[id]` | 140 kB | 112 kB | 163 kB | +51 kB |
| `/chat` | 142 kB | 113 kB | 166 kB | +53 kB |
| `/conversations` | 139 kB | 110 kB | 161 kB | +51 kB |
| `/usage` | 136 kB | 107 kB | 158 kB | +51 kB |

Todas as rotas autenticadas ficam dentro do orçamento de +70 kB. Estágio intermediário medido para registro: antd no layout raiz com `Form`/`App` = login 245-247 kB.

Arquitetura:
- **`/login` e `/register` fora do antd**: ficam em `app/login` e `app/register`, fora do route group `app/(app)/`; só usam `src/components/ui.tsx` (HTML + tokens).
- **`app/(app)/layout.tsx`** monta `AntdRegistry` + `ConfigProvider` (`buildTheme(dark)`, `hashed:false`, tema por cookie) e o `Shell` (`Layout`, `Sider`, `Drawer`). Só rotas autenticadas pagam esse piso (~50 kB gzip).
- **Dinâmico**: `Modal` de coleções (chunk sob demanda) e `Table` do `extract_table` no chat.
- Sem Zod no cliente: `@docmind/shared` só com `import type`.
- Ficaram nativos por peso ou acessibilidade: textarea do chat (`Input.TextArea` +86 kB), Statistic/Progress do uso (+90 kB), Select, checkbox, Skeleton (`role=status`), zona de upload (`Upload.Dragger` não expõe `aria-label`), links de navegação (`Menu` esconde o papel de link).

Versões instaladas: `antd` 6.6.8, `@ant-design/nextjs-registry` 1.3.0, `@ant-design/icons` 6.3.4 (`dayjs` e `@ant-design/cssinjs` vêm transitivos do antd). `next.config.ts` usa `experimental.optimizePackageImports: ['antd']`.

Cuidados para não inflar o bundle: importe de `antd` por componente nomeado (`import { Button } from 'antd'`), nunca `import * as`; use ícones nomeados de `@ant-design/icons`; evite `DatePicker`/`Table` em rotas leves, pois puxam dayjs e muito CSS-in-JS.
