# AGENTS.md - magnus-oathweave

Read the repository root `AGENTS.md` first. Its privacy rules apply here too.

`packages/oathweave` (`@hivemagnus/magnus-oathweave`) holds the Oathweave token verifier and identity
link parser shared by `services/control-api` and `services/fleet-gateway`.

- This package is private and never published. The server and gateway carry it through
  `bundleDependencies`; see `scripts/link-into-consumer.mjs`. Keep `@hivemagnus/hive-common`, `jose`
  and `zod` as peer dependencies, and keep them direct dependencies of every consumer.
- Verification itself lives in `@hivemagnus/hive-common/oathweave`. Keep this package a thin layer:
  Magnus's settings, its link contract and its public names. Fix verifier bugs upstream.
- Verification fails closed. Never add a fallback, an unverified decode or a second algorithm.
- Keep it free of Hono, Prisma and any application code: consumers supply their own request handling.
- Run `npm run test -w @hivemagnus/magnus-oathweave`. The server's `src/middleware/oathweave.test.ts`
  covers the verifier end to end through its re-export, so run that too when changing behaviour.
