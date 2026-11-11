# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
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
