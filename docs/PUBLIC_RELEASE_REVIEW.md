# Public-release privacy and security review

Reviewed on 2026-10-31, before publication. This covers the current source,
all eight pre-existing fetched commits across the default branch, tag and six Dependabot
branches, package manifests, compiled npm payloads, authentication and proxy
boundaries, retained SSH code, and the GitHub publication configuration.

## Findings fixed

| Finding | Change and verification |
| --- | --- |
| Deleted source survived in npm payloads, including private infrastructure defaults | Clean TypeScript output before every package build. Regression tests build a fixture twice, delete a source file between builds, and verify its compiled output disappears. All six rebuilt payloads pass content and path scans. |
| Secret scanning missed provider tokens and staged-only secrets; an unrelated placeholder word could suppress a finding | Recognize common npm, GitHub, OpenAI, Slack and AWS credential signatures. Check the Git index as well as working files. Restrict placeholder exemptions to the value itself. Tests cover staged secrets under a sanitized working copy and secrets inside generated JavaScript. |
| Privacy checks could expose matched contents in their own logs | Report filenames, line numbers and rule names with values redacted. Extend forbidden paths and ignore rules to local state, database sidecars, credentials and package archives. |
| Proxy request limits trusted `Content-Length` | Enforce the byte limit while reading the body and cancel oversized streams. Tests cover absent and misleading lengths, UTF-8 byte counts, interrupted input and exact-limit bodies. |
| SSH helpers accepted unverified server keys | Require operator-provided `SSH_HOST_KEY_PINS_FILE` pins. A real loopback SSH test proves a changed key receives neither authentication nor a command. Database integration coverage preserves the existing durable SSH admission checks. |
| Retired deployment implementations still shipped unsafe shell and broad source-transfer code | Remove the unused deployment and migration services and their obsolete tests. Test that legacy deployment routes still require authentication and return 410 even for administrators. |
| Production and development dependencies had known advisories | Update the HTTP adapter, test runner, worker pool, lint tooling and affected transitive dependencies. Remove unused lint dependencies. Verify the clean installed tarballs independently of monorepo overrides. |
| Publishing omitted repository gates and relied on an unprotected environment | Generate the Prisma client, check the lockfile and run the full verification before publishing. Pin GitHub actions to verified release commits. Refuse real publication unless the GitHub environment has an actual required reviewer. |
| Manual publication could use a branch, and registry failures looked like unpublished versions | Require the matching version tag for every real publication. Complete all registry lookups before publishing, accept only an explicit 404 as an absent version, and test authentication failures, outages and malformed registry responses. Dry runs inspect every package. |
| Bundled agent metadata reported an obsolete version | Align the metadata with the release and reject inconsistent package, internal dependency or bundled agent versions before publication. |

## Privacy evidence

The initial two-commit history contained 1,078 unique blobs. A separate
Gitleaks 8.30.1 scan, repeated after fetching all remote branches, reported
29 candidates. Each was checked against its source: all were synthetic test
credentials or SHA-256 digests of named test tokens. No live credential was
confirmed. The repository's private-term checks and scans for private network
domains and personal build paths pass on the current source and rebuilt
packages. Public author identities and dependency acknowledgements remain.

This is a focused source and publication review, not a penetration test of a
running installation. Ignored operator state is outside the publication
payload and was not copied into this report.

## Remaining development advisory

The production audit reports **zero vulnerabilities**, both in the repository
and in a clean installation of all six packed packages.

The full development audit retains three moderate entries for one dependency
chain: `openapi-typescript` → `@redocly/openapi-core` → `minimatch@5.1.9`.
The underlying advisory is
[globparts amplification](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
The compatible Redocly release still uses the callable minimatch API. The
patched minimatch major changes that API, while Redocly 2 changes private
module exports that this generator imports. Forcing either upgrade breaks
the toolchain; those overrides were not retained.

This dependency is development-only and is absent from published runtime
dependencies. The generation check processes the repository's own generated
OpenAPI document. Do not extend it to untrusted specifications or Redocly
configuration until a compatible upstream fix is available. The audit is
intentionally not suppressed.

## Release state

- The publication workflow is enabled. The `npm-publish` GitHub environment
  still needs a required reviewer: GitHub rejected the requested protection
  rule because the current plan does not support it for this private repository.
  Make the repository public or use a plan supporting private environment
  reviewers, then configure the reviewer before real publication. The workflow
  rejects an unprotected configuration; dry runs remain available.
- The existing `v1.0.0` tag points to the original release snapshot, before
  these fixes. Release from a commit containing this review's changes. Do not
  publish the unchanged old tag.
- Version `1.0.1` contains the review fixes and aligned package metadata. Preserve
  the original tag and use `v1.0.1` for the corrected release.
- Repository visibility and npm authentication remain maintainer release actions.
  The packages are not publicly available on npm yet. Follow the
  [publication guide](PUBLISHING.md) for first-publication authentication and
  per-package trusted publisher configuration.

## Validation

- Full `npm run verify`: builds, strict type checks, workspace tests, OpenAPI
  checks, package installation check, all six npm payload checks, catalogue
  and documentation checks, and cleanup tests.
- UI and Ardent lint checks.
- All 154 server integration tests passed against disposable PostgreSQL and
  Redis, including the real SSH ownership fixture.
- Privacy regression tests exercise provider-token detection, index contents,
  redacted failures, generated package contents and clean rebuilds.
- A clean install of all six actual tarballs passed a production audit and
  CLI smoke checks. The installed dashboard was also started outside the
  checkout and checked through its HTTP health and authentication endpoints.
