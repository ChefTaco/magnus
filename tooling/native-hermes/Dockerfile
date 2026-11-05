# syntax=docker/dockerfile:1.7
FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6c4f23a5f2df22866bd7857e5d304b67a564f4feab6ac22044dde719b AS uv
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS sqlite
# Same fixed SQLite source and digest as the reviewed public Hermes Dockerfile.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -fsSL --retry 3 https://sqlite.org/2026/sqlite-autoconf-3530400.tar.gz -o /tmp/sqlite.tar.gz && \
    echo '0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c  /tmp/sqlite.tar.gz' | sha256sum -c - && \
    tar -xf /tmp/sqlite.tar.gz -C /tmp && cd /tmp/sqlite-autoconf-3530400 && \
    CFLAGS='-fPIC -O2 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_UNLOCK_NOTIFY -DSQLITE_THREADSAFE=1' ./configure --prefix=/opt/sqlite-fixed --enable-static && \
    make -j2 && make install
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS python
COPY --from=uv /usr/local/bin/uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/hermes-native/python UV_PYTHON_PREFERENCE=only-managed UV_LINK_MODE=copy UV_NO_BUILD=1
WORKDIR /opt/hermes-native
RUN uv python install 3.13.13 --no-bin
FROM sqlite AS python_sqlite
COPY --from=python /opt/hermes-native/python /opt/hermes-native/python
COPY sqlite-loader.py /tmp/sqlite-loader.py
# The standalone interpreter statically embeds SQLite in _sqlite3. Rebuild only
# that standard module from exact CPython source against the fixed SQLite;
# preloading a different shared library cannot repair its hidden symbols.
RUN curl --proto '=https' --tlsv1.2 -fsSL --retry 3 https://www.python.org/ftp/python/3.13.13/Python-3.13.13.tar.xz -o /tmp/python.tar.xz && \
    echo '2ab91ff401783ccca64f75d10c882e957bdfd60e2bf5a72f8421793729b78a71  /tmp/python.tar.xz' | sha256sum -c - && \
    tar -xf /tmp/python.tar.xz -C /tmp && \
    pyroot=$(find /opt/hermes-native/python -mindepth 1 -maxdepth 1 -type d -name 'cpython-*') && \
    suffix=$("$pyroot/bin/python3.13" -I -c 'import sysconfig;print(sysconfig.get_config_var("EXT_SUFFIX"))') && \
    gcc -shared -fPIC -O2 -Wl,-Bsymbolic -DPy_BUILD_CORE_MODULE -DMODULE_NAME='"sqlite3"' \
      -I"$pyroot/include/python3.13" -I/tmp/Python-3.13.13/Include/internal -I/opt/sqlite-fixed/include \
      /tmp/Python-3.13.13/Modules/_sqlite/*.c /opt/sqlite-fixed/lib/libsqlite3.a -lm -ldl \
      -o "$pyroot/lib/python3.13/lib-dynload/_sqlite3$suffix" && \
    mkdir -p "$pyroot/lib/python3.13/site-packages" && cp /tmp/sqlite-loader.py "$pyroot/lib/python3.13/site-packages/sitecustomize.py" && \
    "$pyroot/bin/python3.13" -I -c 'import sqlite3,_sqlite3,sys; print(_sqlite3.__file__,sqlite3.sqlite_version,flush=True); assert sqlite3.sqlite_version_info >= (3,51,3); db=sqlite3.connect(":memory:");db.execute("CREATE VIRTUAL TABLE docs USING fts5(content, tokenize=trigram)");print(sqlite3.sqlite_version)'
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
COPY --from=uv /usr/local/bin/uv /usr/local/bin/uv
COPY --from=python_sqlite /opt/hermes-native/python /opt/hermes-native/python
ENV UV_PYTHON_INSTALL_DIR=/opt/hermes-native/python UV_PYTHON_PREFERENCE=only-managed UV_LINK_MODE=copy UV_NO_BUILD=1
WORKDIR /opt/hermes-native
COPY source/ ./source/
RUN uv sync --project source --python 3.13.13 --frozen --no-dev --no-install-project && \
    mkdir dependencies && cp -a source/.venv/lib/python3.13/site-packages/. dependencies/ && \
    rm -rf source/.venv /root/.cache/uv && \
    find python -mindepth 1 -maxdepth 1 -type l -delete && \
    find . -type d -name __pycache__ -prune -exec rm -rf {} +
COPY launcher.mjs runner.py provenance.json NOTICE ./
RUN node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("provenance.json"));fs.mkdirSync("node_modules/hermes-agent",{recursive:true});fs.writeFileSync("node_modules/hermes-agent/package.json",JSON.stringify({name:"hermes-agent",version:p.version,license:"MIT",source:p.source,revision:p.revision}));' && \
    mkdir -m 0700 /tmp/hermes-preflight && touch /tmp/hermes-preflight.env && chmod 0600 /tmp/hermes-preflight.env && \
    node launcher.mjs --env-file /tmp/hermes-preflight.env --profile-path /tmp/hermes-preflight --native-preflight && \
    test -z "$(find /tmp/hermes-preflight -mindepth 1 -print -quit)" && \
    node launcher.mjs --env-file /tmp/hermes-preflight.env --profile-path /tmp/hermes-preflight --native-init-profile && \
    rm -rf /tmp/hermes-preflight /tmp/hermes-preflight.env && \
    chmod -R go-rwx /opt/hermes-native && chown -R node:node /opt/hermes-native
USER node
ENTRYPOINT ["node", "/opt/hermes-native/launcher.mjs"]
