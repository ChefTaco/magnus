# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /opt/codex
COPY tooling/native-codex/package.json tooling/native-codex/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY tooling/native-codex/launcher.mjs tooling/native-codex/acceptance.mjs tooling/native-codex/verification-relay.mjs ./
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Magnus native Codex export" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus"
WORKDIR /opt/codex
COPY --from=dependencies /opt/codex/ ./
USER node
ENTRYPOINT ["node", "/opt/codex/launcher.mjs"]
