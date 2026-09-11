# KernelJSON admission door (apps/gateway). Production HTTP service that serves POST /v1/tasks
# and GET /healthz. Mirrors worker.Dockerfile; adds apps + services (the gateway imports
# services/kernel, services/memory, services/world-model and apps/mission-control).
#
# Secrets (KJ_ADMISSION_BEARER, DATABASE_URL) are NEVER baked into the image; they are injected
# at run time from jVault (e.g. `jvault run --project kerneljson-canary-admit -- ...`).
FROM node:22.19.0-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@10.4.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
EXPOSE 8081
CMD ["node", "--import", "tsx", "apps/gateway/src/main.ts"]
