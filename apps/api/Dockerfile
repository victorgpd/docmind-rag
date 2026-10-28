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
RUN --mount=type=cache,target=/pnpm/store pnpm install --offline --frozen-lockfile

# shortcut: devDependencies (tsx) ficam na imagem pois roda via tsx; trocar por build JS quando existir. Sem pnpm no runtime (corepack baixaria como node).
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/api
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/v1/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/app/node_modules/.bin/tsx","src/main.ts"]
