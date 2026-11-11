# syntax=docker/dockerfile:1.7
#
# magnus-server container image.
#
# Build from the monorepo root (the build context must contain the workspace
# packages this image bundles):
#
#   docker build -f services/control-api/Dockerfile -t magnus-server:local .
#
# Stage 1 builds @hivemagnus/magnus-contracts, @hivemagnus/magnus-oathweave, @hivemagnus/magnus-skills and
# @hivemagnus/magnus-server, and packs the published ones with `npm pack`; the
# server's tarball carries the Oathweave package. Stage 2 installs those tarballs
# exactly as `npm install @hivemagnus/magnus-server` would, so the image runs the
# same artifact that is published to npm.
# Services/control-api/Dockerfile.dockerignore limits what the context sends.

ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.1-1@sha256:7671ab0a702c273c37a84d089ba6fe821c6d85cbeab888e7e43522a057da5e6d
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# ─── Stage 1: build and pack the workspace packages ──────────────────────────
# JavaScript builds and packs are platform independent: build once on the runner.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/magnus-build
COPY . .
RUN npm ci --no-audit --no-fund --ignore-scripts \
      --workspace @hivemagnus/magnus-contracts \
      --workspace @hivemagnus/magnus-oathweave \
      --workspace @hivemagnus/magnus-skills \
      --workspace @hivemagnus/magnus-server \
  && npm rebuild esbuild prisma @prisma/engines
RUN npm --workspace @hivemagnus/magnus-contracts run build \
  && npm --workspace @hivemagnus/magnus-oathweave run build \
  && npm --workspace @hivemagnus/magnus-skills run build \
  && npm --workspace @hivemagnus/magnus-server run db:generate \
  && npm --workspace @hivemagnus/magnus-server run build
RUN mkdir -p /packages \
  && for workspace in packages/contracts packages/skills services/control-api; do \
       (cd "$workspace" && npm pack --ignore-scripts --pack-destination /packages); \
     done \
  && ls -l /packages

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime-dependencies
ARG MAGNUS_VERSION=0.0.0-local
ARG POSTGRES_CLIENT_MAJOR=17
LABEL org.opencontainers.image.title="magnus-server" \
      org.opencontainers.image.description="Magnus server: fleet control plane API" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MAGNUS_VERSION}"
# Native addons are built here; maintained database clients enter only the final stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/magnus-server
COPY --from=builder /packages/ /tmp/packages/
COPY services/control-api/docker/entrypoint.sh /usr/local/bin/magnus-server-entrypoint
# Install the packed server with its sibling workspace packages pinned to the
# local tarballs; third-party dependencies come from the npm registry.
RUN node -e ' \
      const fs = require("node:fs"); \
      const files = fs.readdirSync("/tmp/packages"); \
      const find = (prefix) => "file:/tmp/packages/" + files.find((file) => file.startsWith(prefix)); \
      const local = { \
        "@hivemagnus/magnus-contracts": find("hivemagnus-magnus-contracts-"), \
        "@hivemagnus/magnus-skills": find("hivemagnus-magnus-skills-"), \
      }; \
      fs.writeFileSync("package.json", JSON.stringify({ \
        name: "magnus-server-runtime", private: true, \
        dependencies: { "@hivemagnus/magnus-server": find("hivemagnus-magnus-server-"), ...local }, \
        overrides: local, \
      }, null, 2)); ' \
  && npm install --omit=dev --no-audit --no-fund \
  && npm rebuild argon2 ssh2 \
  && npm cache clean --force \
  && rm -rf /tmp/packages \
  && apt-get purge -y --auto-remove python3 make g++ \
  && chmod 0755 /usr/local/bin/magnus-server-entrypoint \
  && install -d -o node -g node -m 0700 /var/lib/magnus \
  && install -d -o node -g node -m 0755 /var/lib/magnus-cert

# Images upgrade by pull: apply pending migrations at startup, after a dump into
# $MAGNUS_HOME/backups (slow or one-way migrations still need
# MAGNUS_AUTO_MIGRATE_ALLOW_SLOW=true). Set MAGNUS_AUTO_MIGRATE=false to migrate by hand.
# Runtime carries only the packed product and its patched shared libraries.
FROM ${RUNTIME_IMAGE} AS runtime
USER root
ARG MAGNUS_VERSION=0.0.0-local
LABEL org.opencontainers.image.title="magnus-server" \
      org.opencontainers.image.description="Magnus server: fleet control plane API" \
      org.opencontainers.image.source="https://github.com/ChefTaco/magnus" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${MAGNUS_VERSION}"
# PostgreSQL 18 clients can back up 17/18; pg_restore stays paired.
RUN apk add --no-cache postgresql-18-client-base
WORKDIR /opt/magnus-server
COPY --from=runtime-dependencies --chown=node:node /opt/magnus-server/ /opt/magnus-server/
COPY --from=runtime-dependencies --chmod=0755 /usr/local/bin/magnus-server-entrypoint /usr/local/bin/magnus-server-entrypoint
RUN mkdir -p /var/lib/magnus /var/lib/magnus-cert && chown -R node:node /var/lib/magnus /var/lib/magnus-cert && chmod 0700 /var/lib/magnus
RUN /usr/libexec/postgresql18/pg_dump --version && /usr/libexec/postgresql18/pg_restore --version
RUN node -e "const req=require('node:module').createRequire(process.cwd()+'/node_modules/@hivemagnus/magnus-server/package.json'); if(typeof req('ssh2').Client!=='function')throw Error('SSH runtime failed');(async()=>{const argon=req('argon2'); const hash=await argon.hash('synthetic proof',{memoryCost:8192,timeCost:1}); if(!await argon.verify(hash,'synthetic proof'))throw Error('Native password hashing failed')})().catch(e=>{console.error(e.message);process.exitCode=1})"

ENV NODE_ENV=production \
    MAGNUS_HOME=/var/lib/magnus \
    MAGNUS_AUTO_MIGRATE=true \
    MAGNUS_AUTO_MIGRATE_BACKUP=true \
    CONTROL_API_PORT=4000 \
    CONTROL_API_BIND_HOST=0.0.0.0 \
    PATH=/usr/libexec/postgresql18:/opt/magnus-server/node_modules/.bin:$PATH
USER node
VOLUME ["/var/lib/magnus"]
EXPOSE 4000
# Startup may first dump and migrate the database (MAGNUS_AUTO_MIGRATE): allow ten minutes.
HEALTHCHECK --interval=10s --timeout=5s --start-period=600s --retries=12 \
  CMD ["magnus-server-entrypoint", "healthcheck"]
ENTRYPOINT ["magnus-server-entrypoint"]
CMD ["start"]
