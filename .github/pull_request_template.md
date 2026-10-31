## Summary

What does this change do, and why?

## Related issues

Closes #

## Changes

-

## Testing

- [ ] `npm run typecheck`
- [ ] `npm test` (or the relevant workspace test suite)
- [ ] `npm run scan:secrets` and `npm run check:private`
- [ ] Manual verification (describe below)

## Checklist

- [ ] Documentation and `.env.example` files are updated where behaviour or configuration changed
- [ ] No secrets, private hostnames or personal data are included
- [ ] OpenAPI snapshots are updated and `npm run openapi:check` passes if an API changed
