FROM node:22.19.0-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@10.4.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY packages ./packages
COPY services/kernel ./services/kernel
COPY services/memory ./services/memory
# KJ-P8 B1: the frozen runtime-role manifest, read by the health check to compare the live catalogue against it.
COPY infrastructure/database/runtime-role-manifest.json ./infrastructure/database/runtime-role-manifest.json
COPY tests/support/worker.ts ./tests/support/worker.ts
COPY tests/support/runtime-roles.ts ./tests/support/runtime-roles.ts
# KJ-P8 B1 stage T: the harness writes the run-bound trace through these, and co-resident.ts reads the pins file.
COPY scripts/b1/trace.ts ./scripts/b1/trace.ts
COPY scripts/b1/refusal-accounting.ts ./scripts/b1/refusal-accounting.ts
COPY infrastructure/database/co-resident-platform-pins.json ./infrastructure/database/co-resident-platform-pins.json
COPY tests/support/model-probe.ts ./tests/support/model-probe.ts
COPY tests/support/capability-probe.ts ./tests/support/capability-probe.ts
COPY tests/support/policy-probe.ts ./tests/support/policy-probe.ts
COPY tests/support/golden-probe.ts ./tests/support/golden-probe.ts
COPY tests/support/identity-probe.ts ./tests/support/identity-probe.ts
COPY tests/support/cognition-probe.ts ./tests/support/cognition-probe.ts
COPY tests/support/mission-fixture.ts ./tests/support/mission-fixture.ts
COPY tests/support/control-test-key.ts ./tests/support/control-test-key.ts
COPY tests/support/routing-probe.ts ./tests/support/routing-probe.ts
COPY tests/support/autonomous-probe.ts ./tests/support/autonomous-probe.ts
CMD ["node", "--import", "tsx", "services/kernel/src/index.ts"]
