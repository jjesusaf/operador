# Operador API: Node 22 + pnpm monorepo, single container.
# Cloudflare Containers run linux/amd64; the platform is pinned so Apple Silicon builds the right image.
FROM --platform=linux/amd64 node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/operator/package.json packages/operator/
COPY packages/harness/package.json packages/harness/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build --filter=api... && pnpm prune --prod

FROM --platform=linux/amd64 node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app .
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
