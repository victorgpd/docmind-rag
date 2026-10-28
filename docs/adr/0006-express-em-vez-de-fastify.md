# ADR 0006 - Express 5 em vez de Fastify na API

- **Status:** aceito (substitui a escolha inicial de Fastify)

## Contexto
A spec aceita "Fastify (ou Express)". A API foi começada em Fastify, mas o dono do projeto decidiu usar Express, que domina e que é o que a maioria dos avaliadores lê sem esforço.

## Decisão
`apps/api` passa a Express 5 (handlers assíncronos que rejeitam vão direto ao error handler). Validação continua com Zod e o contrato continua em `@docmind/shared`. `packages/observability` e `packages/security` viraram middlewares Express (`requestLogging`, `observability`, `rateLimit`); a lógica de tracing, métricas, limiters, upload e delimitação de prompt não mudou.

## Consequências
- Menos recursos prontos: sem validação/serialização por schema embutida nem plugins com encapsulamento; isso volta como middlewares e helpers.
- OpenAPI deixa de sair do schema da rota automaticamente e precisa ser gerado a partir dos schemas Zod.
- Testes de HTTP passam a usar supertest em vez de `app.inject`.
- Fastify é mais rápido, mas a API não é o gargalo: o tempo está no banco e no modelo.
