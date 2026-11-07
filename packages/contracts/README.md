# @hivemagnus/magnus-contracts

Zod schemas and TypeScript types for the wire contracts that the Magnus server
(`@hivemagnus/magnus-server`), the console (`@hivemagnus/magnus-ui`) and the
node agent (`@hivemagnus/magnus-agent`) share.

The exports cover:

- dependency health and fleet readiness
- API success and error envelopes
- timeline entries and incident summaries
- Hermes Agent effective state and rollout status
- agent heartbeat acceptance
- versioned operational observations (`magnusObservationSchema`)
- Ardent node and profile state, and a typed Ardent HTTP client generated from
  the Ardent OpenAPI document

The `@hivemagnus/magnus-contracts/browser` export holds the browser console's request and response
schemas and imports only `zod`. It is listed by route in
[the console API inventory](https://github.com/ChefTaco/magnus/blob/main/docs/console-api.md).

## Install

```bash
npm i @hivemagnus/magnus-contracts
```

## Usage

```ts
import {
  fleetReadinessSchema,
  magnusObservationSchema,
  type FleetReadiness,
} from '@hivemagnus/magnus-contracts';

const readiness: FleetReadiness = fleetReadinessSchema.parse(await response.json());
```

Validate untrusted wire data with the exported Zod schema before you treat it
as the matching TypeScript type.

The package is ESM only and requires Node.js `^24.22.1` or `^26.13.0`.

## Development

From the repository root, after `npm install`:

```bash
npm --workspace @hivemagnus/magnus-contracts run typecheck
npm --workspace @hivemagnus/magnus-contracts test
npm --workspace @hivemagnus/magnus-contracts run build
```

`src/ardent-openapi.ts` is generated from the OpenAPI document of the pinned,
published `@hivemagnus/ardent` package ([source](https://github.com/ChefTaco/Ardent)). Do not edit it by
hand. After upgrading the pinned Ardent version, regenerate it from the repository
root with `npm run ardent:openapi:write`; `npm run ardent:openapi:check` checks that
it is current.

## License

Apache-2.0
