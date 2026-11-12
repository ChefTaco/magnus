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

ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.1-1@sha256:7671ab0a702c273c37a84d089ba6fe821c6d85cbeab888e7e43522a057da5e6d
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

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

FROM ${NODE_IMAGE} AS runtime-dependencies
ARG MAGNUS_VERSION=0.0.0-local
LABEL org.opencontainers.image.title="magnus-agent" \
      org.opencontainers.image.description="Magnus node agent (container mode)" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MAGNUS_VERSION}"
WORKDIR /opt/magnus-agent
COPY --from=builder /packages/ /tmp/packages/
RUN node -e ' \
      const fs = require("node:fs"); \
      const files = fs.readdirSync("/tmp/packages"); \
      const find = (prefix) => "file:/tmp/packages/" + files.find((file) => file.startsWith(prefix)); \
      const local = { "@hivemagnus/magnus-contracts": find("hivemagnus-magnus-contracts-") }; \
      fs.writeFileSync("package.json", JSON.stringify({ name: "magnus-agent-runtime", private: true, \
        dependencies: { "@hivemagnus/magnus-agent": find("hivemagnus-magnus-agent-"), ...local }, overrides: local }, null, 2)); ' \
  && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force \
  && rm -rf /tmp/packages \
  && install -d -o node -g node -m 0700 /var/lib/magnus-agent

# The container-only agent needs no package manager, host tools or native compiler.
FROM ${RUNTIME_IMAGE} AS runtime
USER root
ARG MAGNUS_VERSION=0.0.0-local
LABEL org.opencontainers.image.title="magnus-agent" \
      org.opencontainers.image.description="Magnus node agent (container mode)" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MAGNUS_VERSION}"
WORKDIR /opt/magnus-agent
COPY --from=runtime-dependencies --chown=node:node /opt/magnus-agent/ /opt/magnus-agent/
RUN install -d -o node -g node -m 0700 /var/lib/magnus-agent \
  && node node_modules/@hivemagnus/magnus-agent/dist/index.js --version

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
