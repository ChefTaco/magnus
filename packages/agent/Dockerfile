# syntax=docker/dockerfile:1.7
#
# magnus-agent container image, for hosts that run only containers. Build
# from the monorepo root:
#
#   docker build -f packages/agent/Dockerfile -t magnus-agent:local .
#
# A container agent runs unprivileged (MAGNUS_AGENT_PRIVILEGED=false), so the
# root-only features (system cron, accounts, package installs, systemd units)
# are off and it reports health, runs commands inside the container, and
# serves files and skills from its volume. It never upgrades itself
# (MAGNUS_AGENT_SELF_UPGRADE=false): pull a newer image instead. Mounting the
# Docker socket is the operator's explicit choice; see the agent README.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

# JavaScript builds and packs are platform independent: build once on the runner.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS builder
WORKDIR /opt/magnus-build
COPY . .
RUN npm ci --no-audit --no-fund --ignore-scripts \
      --workspace @hivemagnus/magnus-contracts \
      --workspace @hivemagnus/magnus-agent
RUN npm --workspace @hivemagnus/magnus-contracts run build \
  && npm --workspace @hivemagnus/magnus-agent run build
RUN mkdir -p /packages \
  && (cd packages/agent && npm pack --ignore-scripts --pack-destination /packages) \
  && (cd packages/contracts && npm pack --ignore-scripts --pack-destination /packages)

FROM ${NODE_IMAGE} AS runtime
ARG MAGNUS_VERSION=0.0.0-local
LABEL org.opencontainers.image.title="magnus-agent" \
      org.opencontainers.image.description="Magnus node agent (container mode)" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MAGNUS_VERSION}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/magnus-agent
COPY --from=builder /packages/ /tmp/packages/
RUN node -e ' \
      const fs = require("node:fs"); \
      const files = fs.readdirSync("/tmp/packages"); \
      const find = (prefix) => "file:/tmp/packages/" + files.find((file) => file.startsWith(prefix)); \
      const local = { "@hivemagnus/magnus-contracts": find("hivemagnus-magnus-contracts-") }; \
      fs.writeFileSync("package.json", JSON.stringify({ name: "magnus-agent-runtime", private: true, \
        dependencies: { "@hivemagnus/magnus-agent": find("hivemagnus-magnus-agent-"), ...local }, overrides: local }, null, 2)); ' \
  && npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && rm -rf /tmp/packages \
  && apt-get purge -y --auto-remove python3 make g++ \
  && install -d -o node -g node -m 0700 /var/lib/magnus-agent

# A container agent never upgrades itself and its Ardent and Codex installs are host-only, so it runs
# no package manager: drop npm, npx, corepack, yarn and apt (their bundled dependencies carry
# fixable CVEs). dpkg and its database stay, so scanners still see the OS packages.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && dpkg --purge --force-remove-protected --force-remove-essential apt libapt-pkg6.0 \
  && rm -rf /etc/apt /var/lib/apt /var/cache/apt /var/log/apt

ENV NODE_ENV=production \
    AGENT_INSTALL_DIR=/var/lib/magnus-agent \
    MAGNUS_AGENT_PRIVILEGED=false \
    MAGNUS_AGENT_CONTAINER=1 \
    MAGNUS_AGENT_SELF_UPGRADE=false \
    PATH=/opt/magnus-agent/node_modules/.bin:$PATH
USER node
WORKDIR /var/lib/magnus-agent
VOLUME ["/var/lib/magnus-agent"]
EXPOSE 4100
ENTRYPOINT ["magnus-agent"]
CMD ["start"]
