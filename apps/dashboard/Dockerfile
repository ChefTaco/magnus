# syntax=docker/dockerfile:1.7
#
# magnus-ui container image. Build from the monorepo root:
#
#   docker build -f apps/dashboard/Dockerfile -t magnus-ui:local .
#
# Stage 1 builds @hivemagnus/magnus-contracts and @hivemagnus/magnus-ui and
# packs the console with `npm pack`. Stage 2 installs that tarball exactly as
# `npm install @hivemagnus/magnus-ui` would, so the image runs the published
# artifact. apps/dashboard/Dockerfile.dockerignore limits the build context.

ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.0-1@sha256:48948514bce59a27f8ee2a3eabaea0a04cbfa87e087297a52f8501c0d465c84f
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

# JavaScript builds and packs are platform independent: build once on the runner.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS builder
# Not /src: the staging step rejects files that mention the build root, and "/src" is too common a substring.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/magnus-build
COPY . .
RUN npm ci --no-audit --no-fund --ignore-scripts \
      --workspace @hivemagnus/magnus-contracts \
      --workspace @hivemagnus/magnus-ui \
  && npm rebuild esbuild
RUN npm --workspace @hivemagnus/magnus-contracts run build \
  && npm --workspace @hivemagnus/magnus-ui run build
RUN mkdir -p /packages \
  && (cd apps/dashboard && npm pack --ignore-scripts --pack-destination /packages) \
  && (cd packages/contracts && npm pack --ignore-scripts --pack-destination /packages) \
  && ls -l /packages

FROM ${NODE_IMAGE} AS runtime-dependencies
ARG MAGNUS_VERSION=0.0.0-local
LABEL org.opencontainers.image.title="magnus-ui" \
      org.opencontainers.image.description="Magnus web console" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MAGNUS_VERSION}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/magnus-ui
COPY --from=builder /packages/ /tmp/packages/
COPY apps/dashboard/docker/entrypoint.sh /usr/local/bin/magnus-ui-entrypoint
RUN node -e ' \
      const fs = require("node:fs"); \
      const files = fs.readdirSync("/tmp/packages"); \
      const find = (prefix) => "file:/tmp/packages/" + files.find((file) => file.startsWith(prefix)); \
      const local = { "@hivemagnus/magnus-contracts": find("hivemagnus-magnus-contracts-") }; \
      fs.writeFileSync("package.json", JSON.stringify({ name: "magnus-ui-runtime", private: true, \
        dependencies: { "@hivemagnus/magnus-ui": find("hivemagnus-magnus-ui-"), ...local }, overrides: local }, null, 2)); ' \
  && npm install --omit=dev --no-audit --no-fund \
  && npm rebuild argon2 ssh2 \
  && npm cache clean --force \
  && rm -rf /tmp/packages \
  && apt-get purge -y --auto-remove python3 make g++ \
  && chmod 0755 /usr/local/bin/magnus-ui-entrypoint \
  && install -d -o node -g node -m 0700 /var/lib/magnus-ui

# Runtime carries only the packed product and its patched shared libraries.
FROM ${RUNTIME_IMAGE} AS runtime
USER root
ARG MAGNUS_VERSION=0.0.0-local
LABEL org.opencontainers.image.title="magnus-ui" \
      org.opencontainers.image.description="Magnus web console" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MAGNUS_VERSION}"
WORKDIR /opt/magnus-ui
COPY --from=runtime-dependencies --chown=node:node /opt/magnus-ui/ /opt/magnus-ui/
COPY --from=runtime-dependencies --chmod=0755 /usr/local/bin/magnus-ui-entrypoint /usr/local/bin/magnus-ui-entrypoint
RUN mkdir -p /var/lib/magnus-ui && chown -R node:node /var/lib/magnus-ui && chmod 0700 /var/lib/magnus-ui
RUN node -e "const req=require('node:module').createRequire(process.cwd()+'/node_modules/@hivemagnus/magnus-ui/package.json'); if(typeof req('ssh2').Client!=='function')throw Error('SSH runtime failed');(async()=>{const argon=req('argon2'); const hash=await argon.hash('synthetic proof',{memoryCost:8192,timeCost:1}); if(!await argon.verify(hash,'synthetic proof'))throw Error('Native password hashing failed')})().catch(e=>{console.error(e.message);process.exitCode=1})"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MAGNUS_UI_DATA_DIR=/var/lib/magnus-ui \
    PATH=/opt/magnus-ui/node_modules/.bin:$PATH
USER node
WORKDIR /var/lib/magnus-ui
VOLUME ["/var/lib/magnus-ui"]
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=12 \
  CMD ["magnus-ui-entrypoint", "healthcheck"]
ENTRYPOINT ["magnus-ui-entrypoint"]
CMD ["start"]
