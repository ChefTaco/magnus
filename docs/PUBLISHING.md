# Publishing Magnus packages

The release workflow is [`.github/workflows/publish.yml`](../.github/workflows/publish.yml).
It builds, tests and scans all six payloads, then publishes libraries before
the applications that depend on them. A dry run publishes nothing.

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

1. Bump the root and all six workspace versions together. Update exact internal
   dependency versions, `package-lock.json`, the server's `agent-version.json`,
   and [the changelog](../CHANGELOG.md).
2. Run `npm run lockfile:check`, `npm run audit:production` and `npm run verify`.
   Commit and push, and wait for CI to pass on that exact commit.
3. Run **Publish to npm** manually with `dry_run` enabled on that commit's ref.
   Inspect the result before proceeding.
4. Create an annotated `vX.Y.Z` tag on the verified commit and push that tag.
   Use a new version for fixes; never move an existing release tag.
5. Review and approve the `npm-publish` deployment in GitHub Actions. Real
   publication requires the matching release tag, including manual retries.
   The npm publisher must already be configured before approving an OIDC run.
6. Verify all six package versions and provenance on npm. A retry skips versions
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
4. Verify the six registry versions and provenance. Configure their trusted
   publishers, revoke the temporary npm token and delete the GitHub environment
   secret. Leave `bootstrap=false` for subsequent releases.

The workflow has no automatic token fallback: bootstrap must be selected
explicitly. Ordinary tag pushes and dry runs do not receive the credential.
`--provenance` cannot work from an ordinary local shell; see
[npm provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).
