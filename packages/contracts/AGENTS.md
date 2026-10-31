# AGENTS.md - magnus-contracts

Read the repository root `AGENTS.md` first. Its privacy rules apply here too.

## Purpose

`packages/contracts` (`@hivemagnus/magnus-contracts`) holds the small set of
Zod schemas and inferred TypeScript types that are deliberately shared across
Magnus package boundaries. It is not a place for package-internal models.

## Rules

- Treat exported schemas as wire contracts. Update producers, consumers and
  tests together.
- Published packages follow semver. Prefer additive, backward-compatible
  changes. Removing or renaming an export is a breaking change.
- Keep runtime dependencies minimal, and never import application code.
- Export both the Zod schema and its inferred TypeScript type.
- `src/ardent-openapi.ts` is generated from the Ardent OpenAPI document. Never
  edit it by hand.
- Fixtures and tests use fake data only: `example.com` or `.invalid` hosts and
  obviously fake identifiers.

## Commands

From the repository root:

```bash
npm --workspace @hivemagnus/magnus-contracts run typecheck
npm --workspace @hivemagnus/magnus-contracts test
npm --workspace @hivemagnus/magnus-contracts run build
```

Tests use Node's built-in runner. They import the `.ts` sources directly
through Node type stripping, so no build step is needed.
