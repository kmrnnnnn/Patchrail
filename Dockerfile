FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS production-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN groupadd --system --gid 1001 patchrail && useradd --system --uid 1001 --gid patchrail patchrail
COPY --from=builder --chown=patchrail:patchrail /app/.next/standalone ./
COPY --from=builder --chown=patchrail:patchrail /app/.next/static ./.next/static
COPY --from=builder --chown=patchrail:patchrail /app/public ./public
COPY --from=builder --chown=patchrail:patchrail /app/worker ./worker
COPY --from=builder --chown=patchrail:patchrail /app/runner ./runner
COPY --from=builder --chown=patchrail:patchrail /app/src ./src
COPY --from=builder --chown=patchrail:patchrail /app/drizzle ./drizzle
COPY --from=builder --chown=patchrail:patchrail /app/package.json ./package.json
COPY --from=builder --chown=patchrail:patchrail /app/tsconfig.json ./tsconfig.json
COPY --from=production-deps --chown=patchrail:patchrail /app/node_modules ./node_modules
USER patchrail
EXPOSE 3000
CMD ["node", "server.js"]
