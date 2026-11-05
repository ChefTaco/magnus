# Optional native Hermes artifact

Magnus packages the reviewed **public** Hermes Agent v2026.9.14 (0.21.3), commit
`345cd2b057a452236de401d3534b8502a7465e8d`. The builder reads an explicit Git
object store and exports only the immutable public runtime allowlist. It never
copies a working checkout, Git history, existing profiles or private forks.
Upstream MIT attribution, runtime assets, bundled Python licenses and dependency
license metadata remain in the artifact. Magnus's wrappers remain Apache-2.0.

```bash
npm run build:native-hermes -- --source PUBLIC_GIT_OBJECT_STORE --tag native-hermes:review
npm run build:native-agent -- --product hermes --image PINNED_IMAGE --output NEW_DIRECTORY
node scripts/check-native-hermes.mjs --artifact PRIVATE_DESCRIPTOR
```

Review the exact resulting image ID before exporting. Source provenance records
the public commit, source archive and `uv.lock` checksums. Dependencies use the
unchanged public lock with `uv sync --frozen --no-dev --no-install-project`;
unlocked package builds and runtime lazy dependency installation are disabled.
The native archive contains an exact Python 3.13.13 standalone runtime from the
checksum catalogue in pinned uv 0.11.6, plus the pinned Node launcher runtime.
No host Python, pip, Node or global package installation is needed. The bundled
Node requires a compatible glibc host (Debian 12+ or Ubuntu 24.04+). Build and
accept each architecture separately; current fixture proof is Linux AMD64 only.

The standalone Python embeds an older SQLite as a built-in module. The builder
rebuilds its standard `_sqlite3` module from checksum-pinned CPython 3.13.13
source against the same checksum-pinned SQLite 3.53.4 source selected by the
reviewed upstream Dockerfile. An owned global Python site customization selects
that module, including in normal bundled-Python subprocesses. Build and native
preflight require SQLite 3.51.3 or newer; the WAL corruption guard stays enabled.
No library is installed on the host or preloaded into unrelated programs.

The headless gateway/CLI launcher requires an explicit `--profile-path DIR` and
`--env-file FILE`. Both paths and sensitive native profile files must be owned,
private and free of links. A conflicting `HERMES_HOME`, Python override, or native
profile selector fails before execution. The launcher preserves existing native
configuration and credential bytes, sets only the selected profile, disables
runtime dependency changes and leaves provider authorization to the operator.
Hermes retains native authentication and provider resolution. TUI/web/desktop
assets and optional provider/tool extras are not installed by this headless
artifact; use a separately reviewed artifact if those capabilities are required.

For an external gateway, configure the native `config.yaml` provider's HTTPS
`base_url`, `key_env` naming its scoped credential in the protected environment,
and `api_mode: chat_completions`. A private CA can use native `ssl_ca_cert` and
`SSL_CERT_FILE`. Keep credentials out of YAML and URLs. The model endpoint stays
distinct from the memory, skills, context and chat integration endpoints.
No model runtime, inference container, model asset, GPU driver or model storage
is installed or managed by this artifact.

`--native-init-profile` explicitly creates only missing private `cron`,
`sessions`, `logs` and `memories` directories under the selected profile. It
retains existing files and refuses links or unsafe existing permissions. The
artifact descriptor records this initialization step separately from preflight.
`--native-verify-profile` performs the corresponding read-only directory and
protected-file checks. It never creates missing directories or changes files.
The lifecycle controller must bind config/environment digests before initialization
and compare them after verification, including recovery from a claimed step.

`--native-preflight` checks the public runtime version, locked client dependencies,
SQLite ABI and native entrypoint syntax without importing profile initialization
hooks. It runs before profile setup and leaves a missing profile layout untouched.
The separate acceptance command imports the actual agent and exercises streaming.
`--native-acceptance` makes one harmless, tool-free generation turn through the
configured native provider and requires streamed response deltas. Acceptance is
explicit and can incur the provider's normal usage charge. The disposable proof
uses a fresh private profile and verified external HTTPS fixture, checks actual
generation/streaming and preserves configuration/credential bytes. Fixture proof
does not certify a real provider entitlement, interactive login, optional tool
integration, other architecture or production installation. Native service
activation remains governed by Hive's separately verified release and supervisor.
