# syntax=docker/dockerfile:1.7
#
# magnus-server container image.
#
# Build from the monorepo root (the build context must contain the workspace
# packages this image bundles):
#
#   docker build -f services/control-api/Dockerfile -t magnus-server:local .
#
# Stage 1 builds @hivemagnus/magnus-contracts, @hivemagnus/magnus-skills and
# @hivemagnus/magnus-server and packs them with `npm pack`. Stage 2 installs
# those tarballs exactly as `npm install @hivemagnus/magnus-server` would, so
# the image runs the same artifact that is published to npm.
# Services/control-api/Dockerfile.dockerignore limits what the context sends.

ARG NODE_IMAGE=node:24.22.1-slim

# ─── Stage 1: build and pack the workspace packages ──────────────────────────
FROM ${NODE_IMAGE} AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund --ignore-scripts \
      --workspace @hivemagnus/magnus-contracts \
      --workspace @hivemagnus/magnus-skills \
      --workspace @hivemagnus/magnus-server \
  && npm rebuild esbuild prisma @prisma/engines
RUN npm --workspace @hivemagnus/magnus-contracts run build \
  && npm --workspace @hivemagnus/magnus-skills run build \
  && npm --workspace @hivemagnus/magnus-server run db:generate \
  && npm --workspace @hivemagnus/magnus-server run build
RUN mkdir -p /packages \
  && for workspace in packages/contracts packages/skills services/control-api; do \
       (cd "$workspace" && npm pack --ignore-scripts --pack-destination /packages); \
     done \
  && ls -l /packages

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
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
  && install -d -o node -g node -m 0700 /var/lib/magnus

ENV NODE_ENV=production \
    MAGNUS_HOME=/var/lib/magnus \
    CONTROL_API_PORT=4000 \
    CONTROL_API_BIND_HOST=0.0.0.0 \
    PATH=/opt/magnus-server/node_modules/.bin:$PATH
USER node
VOLUME ["/var/lib/magnus"]
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=12 \
  CMD ["magnus-server-entrypoint", "healthcheck"]
ENTRYPOINT ["magnus-server-entrypoint"]
CMD ["start", "--migrate"]
