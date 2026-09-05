FROM node:22.19.0-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@10.4.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY packages ./packages
COPY services/kernel ./services/kernel
COPY tests/support/worker.ts ./tests/support/worker.ts
COPY tests/support/model-probe.ts ./tests/support/model-probe.ts
COPY tests/support/capability-probe.ts ./tests/support/capability-probe.ts
COPY tests/support/policy-probe.ts ./tests/support/policy-probe.ts
COPY tests/support/golden-probe.ts ./tests/support/golden-probe.ts
COPY tests/support/routing-probe.ts ./tests/support/routing-probe.ts
COPY tests/support/autonomous-probe.ts ./tests/support/autonomous-probe.ts
CMD ["node", "--import", "tsx", "services/kernel/src/index.ts"]
