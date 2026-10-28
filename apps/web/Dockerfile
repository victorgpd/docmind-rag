# syntax=docker/dockerfile:1
# Contexto de build: raiz do repo (docker build -f apps/web/Dockerfile .)
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
# rewrites do Next sao resolvidos no build: API_URL precisa estar definido aqui
ARG API_URL=http://api:3001
ENV API_URL=$API_URL NEXT_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p apps/web/public && pnpm --filter @docmind/web build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# standalone de monorepo: server.js fica em apps/web/ dentro de .next/standalone
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","apps/web/server.js"]
