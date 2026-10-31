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
   publishing new packages. Never commit npm credentials or put an npm write
   token in this workflow.
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
For the initial publication, an authenticated maintainer must publish the
reviewed package payloads from a supported CI provenance provider, then
configure trust for subsequent versions. An OIDC-only workflow cannot
bootstrap names that do not exist yet. First-publication authentication must
be arranged before starting a real release.
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

First publication with provenance needs a supported cloud CI runner and a
temporary, narrowly scoped npm credential. Keep that credential available
only to the final publish step behind the environment's required review,
then revoke it and use trusted publishing for subsequent releases. The
current workflow has no token fallback. `--provenance` cannot work from an
ordinary local shell; see
[npm provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).
