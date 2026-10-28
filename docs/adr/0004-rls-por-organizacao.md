# ADR 0004 - Isolamento multi-tenant por Row Level Security

- **Status:** aceito

## Contexto
Uma empresa nunca pode ver dados de outra. Filtrar por `organization_id` em cada query depende de ninguém esquecer o `WHERE`.

## Decisão
Toda tabela de conteúdo tem `organization_id` e RLS forçada, com policy `organization_id = current_setting('app.org_id')`. Toda query de tenant passa por `withOrg(orgId, fn)`, que abre uma transação, faz `SET LOCAL ROLE docmind_app` e define `app.org_id`. A conexão crua é privilegiada e só serve a auth, ao worker e às migrations.

## Consequências
- Um filtro esquecido no código não vaza dados: o banco recusa.
- Cada acesso custa uma transação curta.
- O worker e a auth usam a conexão que ignora RLS; ali o cuidado volta a ser do código (sempre filtrar por organização).
- `SET LOCAL` exige pooler em modo transação (PgBouncer em modo sessão quebraria).
- Precisa de testes que provem o isolamento: dois tenants, mesma query, zero linhas cruzadas.
