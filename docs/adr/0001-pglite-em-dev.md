# ADR 0001 - PGlite em dev e testes, Postgres real por configuração

- **Status:** aceito

## Contexto
O avaliador precisa rodar o projeto sem Docker e sem conta alguma. Mas o produto depende de pgvector, full-text e RLS, recursos que um SQLite ou um mock não reproduzem.

## Decisão
Em dev e nos testes usamos o PGlite (Postgres em WASM, com pgvector). Com `DATABASE_URL` setado, a mesma aplicação fala com um Postgres real. O SQL das migrations é o mesmo nos dois.

## Consequências
- Testes de integração rápidos, em memória (`pgliteDir: ':memory:'`), sem Testcontainers.
- O comportamento de RLS e dos índices é o do Postgres de verdade.
- PGlite aceita um único processo por diretório: API e worker separados só funcionam com Postgres real.
- Desempenho e concorrência do PGlite não representam produção; carga se mede no Postgres.
