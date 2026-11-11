# Context-only Ardent adoption

Compaction is implemented by Ardent's direct, pinned Emberfold library. This
managed path installs that context integration into an existing runtime without
replacing its channels, plugins, credentials, schedules, or other capabilities.
The stateless Emberfold HTTP service is not involved.

## Prerequisites

- A privileged current node manager and Control API, with either completed full
  resource enrollment or an authoritative Ardent-only resource scope. Neither
  path bypasses admission, uncertain leases, or participant drain requirements.
- Exactly one profile in the selected owner installation; the reviewed managed
  user-service unit must already match byte-for-byte.
- A supported existing runtime with a legacy-readable checkpoint implementation,
  owner-private SQLite state, and enabled, pinned compaction policy. Legacy
  read permissions are accepted only inside an owner-only state directory;
  group/world-writable databases and exposed state directories are rejected.
- No queued, running, or input-required tasks, queued deliveries, or existing
  one-way profile admission fence. Unknown effects remain unknown.
- Enough space for a runtime clone, retained previous runtime and SQLite backup.
  The manager checks available space before staging.

Do not use `package-install` to replace an extended runtime for this operation.

For a whole-package update, stop the managed profiles first. On consecutive updates,
the node agent verifies both package receipts and package trees, then retains the
older `ardent.previous` as a sibling `ardent.previous.<id>`. The most recent
package remains at `ardent.previous`. The agent keeps these checkpoints intact
and refuses to overwrite a checkpoint it cannot verify or an interrupted update
with no active installation. Preserve these directories when investigating a refusal.
It refuses an active context overlay. Public runtime version and context-engine
adoption are separate identities; the overlay does not relabel the base version.

## Protocol

All Control API routes below are admin-only, beneath `/api/v1`. Node calls pass
through the signed managed-mutation boundary, its resource lease and deadline.
There is no unmanaged fallback. Responses contain metadata, not conversations.
Full-node authority keeps node-wide lease ownership while using the native
Ardent coordination fence; it does not create an Ardent-only enrollment.

1. Read `GET /ardent/installations/{nodeId}/profiles/{name}/context-release`.
   Require `single_profile` and `service_unit_matches` to be true. Retain the
   bundle, base-runtime, policy and configuration digests privately.
2. Generate a fresh UUID and record the intent before each POST. Submit
   `POST /ardent/installations/{nodeId}/profiles/{name}/action` with:

   ```json
   {
     "action": "context-stage",
     "body": {
       "release_id": "11111111-1111-4111-8111-111111111111",
       "expected_bundle_sha256": "<64 lowercase hexadecimal characters>",
       "expected_base_sha256": "<64 lowercase hexadecimal characters>",
       "expected_policy_sha256": "<64 lowercase hexadecimal characters>",
       "expected_config_sha256": "<64 lowercase hexadecimal characters>"
     }
   }
   ```

   No `target`, commands, URLs or credentials are accepted. Use a new UUID, not
   the synthetic example. Staging leaves the live runtime unchanged, copies it
   as the owner, and overlays only context modules and pinned engine dependencies.
   The bundled adapter is built from the release sources, never stale `dist`.
   Schema 2 also carries the pinned SQLite 3.54.1 driver and Linux glibc x64/arm64
   Node-API binaries inside the candidate package. Staging remains offline, the
   complete candidate tree is hashed, and the payload stays within existing size
   limits. Schema 1 remains readable for legacy bundles. A context overlay does
   not patch unrelated code in the retained base runtime; use the full Ardent
   upgrade for product-wide security updates.
3. Require a verified signed receipt and `prepared`. Acceptance uses an isolated
   SQLite fixture and the owner's configured Codex provider with tools disabled:
   real compaction, continuation using the primary model, exact source recovery,
   corruption detection, rebuild, and previous-reader compatibility. It neither
   submits a real task nor replays an external effect.
4. Submit `context-adopt` with the identical body. The manager pins the original
   and candidate trees, checks quiescence, stops the gateway without changing
   enablement, checks the released execution lock, backs up SQLite, and switches
   the runtime. It starts the gateway and verifies health, original journal
   prefixes, existing unknown states and checkpoint heads. It then physically
   switches back to the previous runtime, repeats verification, and restores the
   adopted runtime with another restart and verification.
5. Require a verified receipt, `active`, and `rollback_verified: true`. Roll out
   one profile at a time, stopping on any failed acceptance check. Retain exact
   release pins and signed completion evidence outside the public repository.

`context-rollback` with the same body switches a proven active release back to
its retained previous runtime and verifies it. It does not restore an old
database or discard messages appended since adoption. Repeated or ambiguous
actions are refused rather than replayed.

## Failure inspection

Read `GET /ardent/installations/{nodeId}/profiles/{name}/context-adoptions/{releaseId}`
to inspect the retained phase and pins without retrying anything. The journal
is private, root-controlled, durable, and bound to the exact owner/profile/runtime
target. Diagnostic stderr remains private on the node under the adoption journal
directory. Owner subprocesses never inherit node-manager credentials.

A timeout, cancellation, crashed switch or failed health check stops the sequence.
The gateway may intentionally remain stopped. Never infer completion from a
journal phase, clear an unsettled lease, erase an execution lock, reopen a one-way
admission fence, or replay the operation. Inspect signed command receipts and
traces through the existing resource-reconciliation protocol first. Any manual
recovery must preserve source data, unknown effects and the retained runtime.

## Verification

`npm run verify` covers unit, contract, package and privacy gates. After building,
run the offline container acceptance on both supported Node lines:

```bash
npm run ardent:context:integration -- --image node:24.22.1-bookworm-slim
npm run ardent:context:integration -- --image node:26.13.0-bookworm-slim
```

This installs the published pre-Emberfold Ardent 1.1.2 into a disposable container,
starts real gateways, verifies compaction/recovery and actual runtime rollback,
and checks that unrelated files, originals, credentials and unknown effects stay
unchanged. The provider is a protocol fixture, not production model evidence.
CI runs both lines; publication requires the Node 24 container gate. Each real
profile still needs its own configured-provider acceptance and signed receipt.
