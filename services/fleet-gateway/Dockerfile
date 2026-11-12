# syntax=docker/dockerfile:1.7
#
# Magnus fleet gateway container image.
#
# Build from the monorepo root:
#
#   docker build -f services/fleet-gateway/Dockerfile -t magnus-fleet-gateway:local .
#
# This image is how the gateway ships: it is not published to npm. Stage 1 builds the workspace
# packages and packs the gateway, whose tarball carries the Oathweave package. Stage 2 installs that
# tarball the way a registry install would, so third-party dependencies come from npm.
#
# Runs as a non-root user and works with a read-only root filesystem:
#
#   docker run --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
#     --mount type=volume,src=fleet-gateway-known-hosts,dst=/var/lib/fleet-gateway/known-hosts \
#     --mount type=bind,src=<key>,dst=/run/secrets/fleet-gateway-ssh-key,readonly \
#     --mount type=bind,src=<tls>,dst=/run/tls,readonly ...

ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.1-1@sha256:7671ab0a702c273c37a84d089ba6fe821c6d85cbeab888e7e43522a057da5e6d
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# ─── Stage 1: build the workspace packages and pack the gateway ──────────────
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS builder
WORKDIR /opt/magnus-build
COPY . .
RUN npm ci --no-audit --no-fund --ignore-scripts \
      --workspace @hivemagnus/magnus-oathweave \
      --workspace @hivemagnus/magnus-fleet-gateway
RUN npm --workspace @hivemagnus/magnus-oathweave run build \
  && npm --workspace @hivemagnus/magnus-fleet-gateway run build
RUN mkdir -p /packages \
  && (cd services/fleet-gateway && npm pack --ignore-scripts --pack-destination /packages) \
  && ls -l /packages

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime-dependencies
ARG MAGNUS_VERSION=0.0.0-local
LABEL org.opencontainers.image.title="magnus-fleet-gateway" \
      org.opencontainers.image.description="Magnus fleet gateway: holds the restricted SSH key and carries the web terminal" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MAGNUS_VERSION}"
WORKDIR /opt/magnus-fleet-gateway
COPY --from=builder /packages/ /tmp/packages/
# --ignore-scripts: ssh2 falls back to Node's own crypto, so the image carries no compiler and no
# native addon to patch.
RUN node -e ' \
      const fs = require("node:fs"); \
      const files = fs.readdirSync("/tmp/packages"); \
      const find = (prefix) => "file:/tmp/packages/" + files.find((file) => file.startsWith(prefix)); \
      fs.writeFileSync("package.json", JSON.stringify({ \
        name: "magnus-fleet-gateway-runtime", private: true, \
        dependencies: { "@hivemagnus/magnus-fleet-gateway": find("hivemagnus-magnus-fleet-gateway-") }, \
      }, null, 2)); ' \
  && npm install --omit=dev --no-audit --no-fund --ignore-scripts \
  && npm cache clean --force \
  && rm -rf /tmp/packages /root/.npm \
  && install -d -o node -g node -m 0700 /var/lib/fleet-gateway /var/lib/fleet-gateway/known-hosts

# Runtime carries only the packed product and its patched shared libraries.
FROM ${RUNTIME_IMAGE} AS runtime
USER root
ARG MAGNUS_VERSION=0.0.0-local
LABEL org.opencontainers.image.title="magnus-fleet-gateway" \
      org.opencontainers.image.description="Magnus fleet gateway: holds the restricted SSH key and carries the web terminal" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MAGNUS_VERSION}"
WORKDIR /opt/magnus-fleet-gateway
COPY --from=runtime-dependencies --chown=node:node /opt/magnus-fleet-gateway/ /opt/magnus-fleet-gateway/
RUN mkdir -p /var/lib/fleet-gateway /var/lib/fleet-gateway/known-hosts && chown -R node:node /var/lib/fleet-gateway /var/lib/fleet-gateway/known-hosts && chmod 0700 /var/lib/fleet-gateway
RUN node -e "const req=require('node:module').createRequire(process.cwd()+'/node_modules/@hivemagnus/magnus-fleet-gateway/package.json'); if(typeof req('ssh2').Client!=='function')throw Error('SSH runtime failed');"

ENV NODE_ENV=production \
    FLEET_GATEWAY_PORT=4310 \
    FLEET_GATEWAY_BIND_HOST=0.0.0.0 \
    FLEET_GATEWAY_KNOWN_HOSTS_FILE=/var/lib/fleet-gateway/known-hosts/known-hosts.json \
    PATH=/opt/magnus-fleet-gateway/node_modules/.bin:$PATH
USER node
VOLUME ["/var/lib/fleet-gateway/known-hosts"]
EXPOSE 4310
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD ["magnus-fleet-gateway", "healthcheck"]
ENTRYPOINT ["magnus-fleet-gateway"]
CMD ["start"]
