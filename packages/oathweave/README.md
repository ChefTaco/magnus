# @hivemagnus/magnus-oathweave

Private workspace package, not on npm: the server and gateway bundle it into their tarballs.

Verifies Oathweave resource tokens for the Magnus server and the Magnus fleet gateway, so both
apply one implementation: issuer, JWKS signature (RS256 only), audience, lifetime, actor type and
online session revocation through userinfo. Failure is closed.

It is a thin layer over the suite's shared verifier, `@hivemagnus/hive-common/oathweave`, set to
Magnus's long-standing rules:

| Setting | Magnus |
| --- | --- |
| Clock tolerance | none (`clockToleranceSec: 0`) |
| Token lifetime and age | at most 900 s, for people and services |
| `roles` claim | required on a person's token (`requireRoles: true`); not read on a service token |
| Client claim | `clientId` only (`clientIdClaim: 'clientId'`) |
| Endpoints | `https` issuer, JWKS and userinfo, without credentials or a fragment |
| Session check | userinfo, shared for 10 s from when its request started (2 s after a failure, 5 000 entries) |
| Permissions | exact names; `*` wildcards grant nothing (`hasOathweavePermission`) |

Every refusal is an `OathweaveError` with a stable `reason` (for example `expired`,
`session_inactive` or `identity_unavailable`). The server and the gateway answer every refusal the
way they always have, as 401. The tests run the shared Oathweave conformance vectors.

It also parses `MAGNUS_OATHWEAVE_IDENTITIES_JSON`, the explicit account links that say which
Magnus role a verified person may hold. A link has exactly `issuer`, `subject`, `localUserId` and
`role`; `localUserId` is a free-form audit label other than `system` or `service:…`. A duplicated
issuer and subject parses, and `uniqueOathweaveLink` then grants that identity nothing.

```ts
import { createOathweaveVerifier, OATHWEAVE_AUDIENCE } from '@hivemagnus/magnus-oathweave';

const verify = createOathweaveVerifier({ issuer, jwksUrl, userinfoUrl, audience: OATHWEAVE_AUDIENCE });
const identity = await verify(token); // throws unless every check passes
```

`identity.authTime` is the token's `auth_time` claim when it is a positive integer, and undefined
otherwise. A consumer that requires recent identity verification treats undefined as stale.

`createOathweaveServiceVerifier({ issuer, jwksUrl, audience })` verifies another product's
client-credentials token instead: `actorType` `SERVICE_ACCOUNT`, `token_type` `access`, a subject equal
to its `clientId`, no `sessionId`, and a lifetime of at most 15 minutes. Such a token can only match a
link whose role is `ARDENT_SERVICE`, and that link's subject is the client ID. The person verifier
keeps refusing service tokens.
