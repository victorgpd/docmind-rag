# syntax=docker/dockerfile:1
# Contexto de build: raiz do repo (docker build -f apps/api/Dockerfile .)
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Cache de dependencias: so lockfile + workspace
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm fetch

FROM deps AS build
COPY . .
# So dependencias de producao da API e dos pacotes do workspace que ela importa, mais o tsx (dependencies da raiz: roda o TS no runtime
# e no cron da demo, /app/node_modules/.bin/tsx). Fora: web, tests, evals e devDependencies (next, mermaid, typescript, turbo, eslint...).
# O `pnpm fetch` deixou o virtual store inteiro em node_modules: apaga e instala do store (cache), offline.
RUN --mount=type=cache,target=/pnpm/store rm -rf node_modules && pnpm install --offline --frozen-lockfile --prod --filter docmind --filter "@docmind/api..."

# shortcut: roda TS via tsx; trocar por build JS quando existir. Sem pnpm no runtime (corepack baixaria como node).
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/api
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/app/node_modules/.bin/tsx","src/main.ts"]
