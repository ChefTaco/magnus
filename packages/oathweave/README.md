# @hivemagnus/magnus-oathweave

Private workspace package, not on npm: the server and gateway bundle it into their tarballs.

Verifies Oathweave resource tokens for the Magnus server and the Magnus fleet gateway, so both
apply one implementation: issuer, JWKS signature (RS256 only), audience, lifetime, actor type and
online session revocation through userinfo. Failure is closed.

It also parses `MAGNUS_OATHWEAVE_IDENTITIES_JSON`, the explicit account links that say which
Magnus role a verified person may hold.

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
