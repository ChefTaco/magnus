# Publishing Magnus packages

The release workflow is [`.github/workflows/publish.yml`](../.github/workflows/publish.yml).
It builds, tests and scans all seven payloads, then publishes libraries before
the applications that depend on them, and the `@hivemagnus/magnus` installer
last. After npm, it publishes the container images to GHCR. A dry run publishes
nothing.

## Required setup

1. Use a public GitHub repository for npm provenance. In GitHub Settings →
   Environments → `npm-publish`, configure a trusted maintainer as a required
   reviewer and disable administrator bypass. Allow the `main` branch for dry
   runs and `v*` tags for releases. If the maintainer also starts releases,
   allow that person to review their own deployment.
2. Verify npm ownership of the `@hivemagnus` scope and enable account 2FA.
   Authenticate interactively with `npm login` on a trusted machine when first
   publishing new packages or configuring trusted publishing. Never commit
   npm credentials.
3. For each existing package, configure its npm trusted publisher to match the
   GitHub owner and repository in `repository.url`, workflow filename
   `publish.yml`, and environment `npm-publish`. Enable the `npm publish`
   permission explicitly. Complete a successful publication within two days
   of creating the trusted publisher configuration.

GitHub required reviewers depend on the repository's visibility and plan;
see [GitHub environment availability](https://docs.github.com/en/rest/deployments/environments#about-deployment-environments).
The workflow refuses real publication if the required reviewer is missing.
The current npm CLI requires a package to exist before configuring trust;
see [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)
and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
For the initial publication, use the explicit bootstrap procedure below, then
configure trust for subsequent versions. OIDC alone cannot bootstrap package
names that do not exist yet.
An unauthenticated dry run cannot prove npm ownership or OIDC configuration.

## Release procedure

1. Run `npm run release:bump X.Y.Z`. It sets the root and every workspace
   version, the exact internal dependency pins, the server's
   `agent-version.json`, the Ardent OpenAPI version, `package-lock.json` and
   the release manifest, and adds a CHANGELOG stub. Then write
   `release/X.Y.Z.json`: the summary, `breaking`, `minUpgradeFrom`, new
   required and optional settings, removed settings, and the migrations this
   release adds. Mark slow or one-way migrations with
   `prisma/migrations/<name>/magnus-impact.json`. Fill in the changelog,
   including **New environment variables** and **Migration impact**, and run
   `npm run release:manifest`. See [UPGRADING.md](../UPGRADING.md#release-notes-for-maintainers).
2. Run `npm run lockfile:check`, `npm run audit:production` and `npm run verify`.
   Commit and push, and wait for CI to pass on that exact commit.
3. Run **Publish to npm** manually with `dry_run` enabled on that commit's ref.
   Inspect the result before proceeding.
4. Create an annotated `vX.Y.Z` tag on the verified commit and push that tag.
   Use a new version for fixes; never move an existing release tag.
5. Review and approve the `npm-publish` deployment in GitHub Actions. Real
   publication requires the matching release tag, including manual retries.
   The npm publisher must already be configured before approving an OIDC run.
6. Verify all seven package versions and provenance on npm, and the image tags
   on GHCR (see [Container images](#container-images)). A retry skips versions
   already published. Registry failures stop publication; a publication failure
   stops subsequent packages and may leave earlier packages published.

## First publication

1. Complete the public-repository setup, required reviewer configuration,
   gates and dry run. Push the verified release tag. Its automatic OIDC run
   will not succeed for package names that have no trusted publisher yet;
   cancel that run before starting bootstrap if it is waiting for review.
2. Create a short-lived npm granular access token with publish access only
   to the required scope/packages: choose **Read and write (publish and stage)**
   and enable **Bypass two-factor authentication** for this noninteractive
   publication. Use the shortest practical expiration and no organization
   administration permissions. See [npm token configuration](https://docs.npmjs.com/creating-and-viewing-access-tokens/).
   Store it as `NPM_BOOTSTRAP_TOKEN` in the protected
   `npm-publish` GitHub environment. Never paste it into workflow inputs,
   source files, issues or logs.
3. Run **Publish to npm** manually from the verified release tag, set
   `dry_run=false` and `bootstrap=true`, then review and approve the GitHub
   environment deployment. The temporary credential is supplied only to the
   final publishing step; installation, builds and tests do not receive it.
   Every package is published with provenance.
4. Verify the registry versions and provenance, revoke the temporary npm
   token and delete the GitHub environment secret. Configure trusted publishers
   when the next OIDC release is ready, so their first successful publish falls
   within npm's two-day setup window. A retry that skips already published
   versions does not complete that first publish. Leave `bootstrap=false` for
   subsequent releases.

The workflow has no automatic token fallback: bootstrap must be selected
explicitly. Ordinary tag pushes and dry runs do not receive the credential.
`--provenance` cannot work from an ordinary local shell; see
[npm provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).

## Adding a package

A new package name (for example `@hivemagnus/magnus` in 1.1.0) has no trusted
publisher yet, so the release that introduces it uses the bootstrap
procedure above: one bootstrap run publishes every package of that version
with the temporary token. Afterwards, configure the trusted publisher for the
new name as well. Later releases use OIDC again.

## Container images

After the npm packages are published, the `images` job builds
`ghcr.io/cheftaco/magnus-server`, `magnus-ui` and `magnus-agent` from
`npm pack` tarballs of the same commit (the bytes that were published), for `linux/amd64` and `linux/arm64`, with provenance and
an SBOM. It tags them `X.Y.Z`, `X.Y` and `X`, never `latest`, and skips
prereleases. It uses the workflow's `GITHUB_TOKEN` (`packages: write`), with
no extra secret.

- **First push:** GHCR creates the packages as private. Make each one public
  under the repository's **Packages** and link it to the repository. The
  `org.opencontainers.image.source` label links it on push.
- **Dry run:** a `dry_run` dispatch builds the images without pushing them.
