# DocMind - Design system v2 (minimalista, com identidade)

Fontes: `apps/web/app/globals.css` (tokens e utilitários `.card`, `.bg-grad`, `.dots`, `.shimmer`), `apps/web/src/theme/antd.ts` (tema do antd, mesmos tokens), `apps/web/src/theme/ThemeProvider.tsx` (claro/escuro) e `apps/web/src/components/icons.tsx` (logo e ícones SVG inline).
Princípios: fundo levemente tingido com superfícies brancas/elevadas; UM acento índigo→violeta (gradiente sutil só em botão primário, logo, avatar e destaques); hierarquia por peso e espaço; leve (ver `docs/BUNDLE.md`).

## Tokens (CSS e `ConfigProvider` com os mesmos valores)
| Token | Claro | Escuro | Uso |
|---|---|---|---|
| `bg` | #f6f7fb | #0b0d14 | fundo da app |
| `surface` | #ffffff | #12151f | cards, campos, sidebar |
| `subtle` | #eef0f7 | #1a1e2b | hover, trilhas |
| `fg` / `muted` | #12141c / #5b6173 | #eceef6 / #9aa1b5 | texto / secundário (AA) |
| `line` / `line-strong` | #e3e6ef / #7c8296 | #232838 / #6b7288 | divisórias / borda de campo (3:1) |
| `brand` / `tint` | #4f46e5 / 9% | #a5b0ff / 14% | acento em texto, foco, item ativo e ícones |
| `primary` + `--grad` | #4f46e5→#7c3aed | #5a5ee8→#7c4ddb | fundo de botão (texto branco ≥ 4.5:1), logo |
| `danger` `ok` `warn` | #b42318 #176437 #7a4f00 | claros equivalentes | erro, status |

- Tipografia: Inter variável auto-hospedada (subset latin, sem CDN), títulos peso 650 com tracking -0.02em, `tabular-nums` em números; h1 de página 26px.
- Raios 8 (controles) e 12 (cards); altura de controle 36; sombra mínima (`--shadow-card`) que cresce no hover (`--shadow-lift`, 150 ms); `prefers-reduced-motion` desliga transições.
- Tema: cookie `docmind_theme` lido no servidor (sem flash) + classe `dark`; foco 2px `brand`.

## Telas
- **Landing `/`** (nativa): hero "Pergunte aos seus documentos. Com fontes.", mockup do chat em HTML/CSS, 4 diferenciais, 3 passos, rodapé; gradiente radial e grade pontilhada em CSS; logado vai para `/collections`.
- **Login/cadastro** (nativos): painel de marca com gradiente + formulário em card, mostrar/ocultar caracteres (`aria-label` "Mostrar caracteres"); uma coluna no mobile.
- **App autenticado**: sidebar com logo, grupos "Espaço de trabalho" (Coleções, Chat, Conversas) e "Conta" (Uso), ícones, pílula ativa com barra, colapsável para ícones (preferência em `localStorage`), cartão do usuário (iniciais, e-mail, barra de uso mensal, "Sair"); topbar com breadcrumb e alternador de tema (ícone sol/lua); Drawer no mobile ("Menu"). Links continuam `<a>` reais.
- **Coleções**: grid de cards (ícone de pasta, nome, descrição, data), botões Editar/Excluir (ícones, `aria-label` "Editar {nome}"/"Excluir {nome}") visíveis no hover/foco. **Documentos**: dropzone tingido, importar por URL em card, lista com ícone por extensão, pill de status (spinner no processamento) e barra fina.
- Estados vazios com ilustração SVG inline; skeleton com shimmer; toasts em card.

## Componentes e arquitetura
- **Landing, login e cadastro 100% nativos** (`app/page.tsx`, `app/login`, `app/register`; `src/components/ui.tsx`: `Button`, `Input`, `PageHeader`, `Skeleton`, `Empty`, `useToast`): leves, sem antd. Formulários com `FormField` (rótulo, dica e erro por `aria-describedby`; resumo `role=alert`).
- **App autenticado em antd** (`app/(app)/layout.tsx` → `AntdShell`: `AntdRegistry` + `ConfigProvider` com `src/theme/antd.ts`, mesmos tokens e tema claro/escuro por cookie): `Drawer` (menu mobile), `Modal` (criar/editar/excluir coleção), `Alert`/`Table` no chat; sidebar, cards, pills e ícones são HTML/CSS próprio. Import por componente; `hashed:false`.
- **Nativo dentro do app, de propósito**: textarea do chat, Statistic/Progress, Select, checkbox, Skeleton, dropzone e links de navegação (peso do bundle e papéis de acessibilidade/E2E). Nunca usar `List` (deprecated no v6), `Form`, `App`, `DatePicker`.
- Consistência entre antd e nativo: mesmo raio 8, altura de controle 36, foco 2px `brand` (global), Inter, `colorLink` = `brand` (links do shell usam `!text-*` para vencer o reset do antd).
- Proibido importar runtime de `@docmind/shared` no cliente (puxa Zod): só `import type`. Orçamento e medições: `docs/BUNDLE.md`.
- Compatibilidade E2E: roles, labels e textos acordados com `tests/e2e` não mudam sem atualizar os testes E2E.

## Contraste (WCAG AA)
Gerado por `pnpm --filter @docmind/web contrast` a partir dos tokens reais de `globals.css` (tingidos compostos sobre a base; gradiente no pior extremo). Texto normal ≥ 4.5:1, componentes e foco ≥ 3:1. Botão desabilitado é isento (WCAG 1.4.3). O script falha se alguma linha cair abaixo do mínimo.

| Combinação | Claro | Escuro | Mínimo |
|---|---|---|---|
| pílula Na fila (muted/subtle) | 5.4 | 6.4 | 4.5 |
| pílula Na fila sobre bg | 5.4 | 6.4 | 4.5 |
| pílula Processando (warn/warn15) | 5.7 | 6.9 | 4.5 |
| pílula Pronto (ok/ok15) | 5.7 | 6.5 | 4.5 |
| pílula Erro (danger/danger15) | 5.1 | 6.2 | 4.5 |
| chip [n] landing (brand/tint em surface) | 5.5 | 7.2 | 4.5 |
| chip [n] (brand/tint em bg) | 5.2 | 7.8 | 4.5 |
| item ativo do menu (brand/tint em surface) | 5.5 | 7.2 | 4.5 |
| ícone/ext. de documento (brand/tint) | 5.5 | 7.2 | 4.5 |
| link brand sobre bg | 5.9 | 9.5 | 4.5 |
| link brand sobre surface | 6.3 | 8.9 | 4.5 |
| muted sobre bg | 5.8 | 7.5 | 4.5 |
| muted sobre surface | 6.2 | 7.1 | 4.5 |
| muted sobre subtle (hover) | 5.4 | 6.4 | 4.5 |
| muted sobre tint (em bg) | 5.1 | 6.2 | 4.5 |
| badge da landing (muted/surface) | 6.2 | 7.1 | 4.5 |
| rótulos do menu 11px (muted/surface) | 6.2 | 7.1 | 4.5 |
| placeholder (muted/surface) | 6.2 | 7.1 | 4.5 |
| fg sobre bg | 17.2 | 16.8 | 4.5 |
| fg sobre surface | 18.4 | 15.7 | 4.5 |
| danger sobre surface | 6.6 | 8.0 | 4.5 |
| danger sobre bg | 6.1 | 8.5 | 4.5 |
| warn sobre surface | 7.1 | 9.1 | 4.5 |
| ok sobre surface | 7.2 | 8.5 | 4.5 |
| branco no botão primário (início do gradiente) | 6.3 | 5.0 | 4.5 |
| branco no botão primário (fim do gradiente) | 5.7 | 5.3 | 4.5 |
| branco no painel de marca (início) | 6.3 | 5.0 | 4.5 |
| branco no painel de marca (fim) | 5.7 | 5.3 | 4.5 |
| botão primário desabilitado (isento WCAG 1.4.3; referência) | 2.8 | 8.7 | 2.5 |
| borda de campo (line-strong/surface) | 3.8 | 3.8 | 3 |
| borda de campo (line-strong/bg) | 3.6 | 4.1 | 3 |
| foco/brand sobre bg | 5.9 | 9.5 | 3 |
| foco/brand sobre surface | 6.3 | 8.9 | 3 |
| brand sobre tint (indicador do menu) | 5.5 | 7.2 | 3 |
