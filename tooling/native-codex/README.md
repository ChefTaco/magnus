# Optional native Codex artifact

This developer build packages the exact Codex version and npm integrity records
in its own lockfile, with the exact Node image selected by the Dockerfile.
Codex and dependency licenses remain in the archive. Build from the repository
root, then export the reviewed immutable image:

```bash
docker build -f tooling/native-codex/Dockerfile -t native-codex:review .
npm run build:native-agent -- --product codex --image PINNED_IMAGE --output NEW_DIRECTORY
```

The native launcher requires `--env-file FILE --profile-path DIR` before a native
Codex command. Both references must be owned and private. It loads the protected
environment without shell evaluation, sets `CODEX_HOME` only to the explicitly
selected profile, and refuses a conflicting reference. It does not edit existing
configuration, import login sessions, authorize a provider, install a system
service or update a runtime. Hive starts selected interactive or stdio consumers
only through their separately configured supervisor. Provider sign-in remains an
operator action. Version preflight proves only the installed runtime version.
The signed descriptor also supplies `--native-acceptance`: one bounded native
Responses turn against the selected external HTTPS endpoint, with a protected
`env_key` credential. Interactive-only providers and credential commands remain
pending until the operator supplies an appropriate explicit credential reference.

Acceptance reads only the model and Responses provider selection from the private
profile. It creates a disposable home and workspace, carries only the selected
credential and TLS trust references, disables shell execution, hooks, apps, plugins
and other integrations, and uses the read-only sandbox. It copies no authentication
session or configured integration into that home. CLI overrides ignore user config
and rules and clear MCP registrations. A random-capability loopback verification
relay makes exactly one authenticated request to the original HTTPS provider,
removes tools, forces no tool selection and validates assistant-text events before
forwarding them to Codex. It rejects redirects, invalid TLS, tool-bearing replies
and excessive input/output. This temporary verification transport contains no
inference runtime or model assets and is removed when acceptance ends. Original configuration and
credential bytes must remain identical. Unexpected events, tool activity, runtime
version mismatch, oversized output or a 60-second turn timeout fail closed; output
contains only bounded non-secret result fields. Existing profiles are not reset
or silently modified. `--expected-answer OK` is available only for deterministic
isolated protocol fixtures; unattended acceptance uses `READY`.

Both the environment and existing native configuration/authentication files must
be owner-private regular files with one link and canonical absolute paths.
Duplicate profile/environment selections, alternate native profile flags and
conflicting saved `CODEX_HOME`/`CODEX_PROFILE` overrides are refused.

For an external gateway, configure the selected Codex profile with a unique
provider ID, its verified HTTPS `base_url`, `wire_api = "responses"`, and an
`env_key` naming the scoped Emberpath credential in the protected environment
file. Keep the model endpoint distinct from memory. Use `CODEX_CA_CERTIFICATE`
for a private CA bundle when needed. See the official
[custom provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
and [private CA configuration](https://learn.chatgpt.com/docs/auth#custom-ca-bundles).
No bearer value belongs in TOML or a URL.

`node scripts/check-native-codex.mjs --artifact PRIVATE_DESCRIPTOR` runs the actual
exported CLI against a disposable external HTTPS protocol fixture. It verifies
Responses streaming, private CA verification, a separate profile, unchanged
credential/configuration bytes and rejection of unsafe profile/file selection.
It uses no existing account or inference service. It does not certify production
provider entitlement or authorize a cutover. Hive never installs an inference
runtime or model assets as part of this artifact.
