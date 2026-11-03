# Security Fusion moves to Cindertrace

Cindertrace owns cases, observations, evidence, correlation, retention,
investigations, assurance, approvals, and response decisions. Magnus retains
fleet inventory, durable observation export, a Cindertrace summary/link, and the
narrow response execution adapter. Historical security tables and applied
migrations are retained for recovery; this release does not drop them.

`SECURITY_FUSION_MODE=local` is retired and fails with migration instructions.
Before upgrading a local-mode installation, freeze its security writers, export
its security tables and evidence with Cindertrace's migration tooling, import
into an isolated Cindertrace database, and verify identities, counts, evidence
hashes, and receipt chains. Then configure remote mode and the Cindertrace URL.
Do not start two security writers or dispatchers. Active or unknown actions and
active isolation block transfer. Cancel pending approvals with an audit record;
request fresh approval after transfer. Never replay an uncertain execution.

Existing `/security-fusion/*` links redirect to the configured console. Retired
local API endpoints return authenticated 410 responses. Fleet operation does
not depend on Cindertrace availability. Existing exporter, inventory, summary,
and external approval credentials remain purpose-scoped.

## Optional response bridge

The bridge is disabled until `CINDERTRACE_RESPONSE_SECRET` is configured. Use a
new dedicated secret matching Cindertrace's `MAGNUS_RESPONSE_SECRET`. Set its
`MAGNUS_RESPONSE_URL` to `/api/v1/security-integration/response` on the Magnus
HTTPS origin. Configure `CINDERTRACE_RESTART_ALLOWLIST` and
`CINDERTRACE_PROTECTED_TARGET_IDS` separately from Cindertrace's own policy.

Install the additive bridge migration and matching managed node adapter before
enabling execution. Each node must opt in with `MAGNUS_SECURITY_RESPONSE_ENABLED`
and `MAGNUS_SECURITY_CONTAINMENT_COMMAND` pointing to a root-owned, non-writable
containment helper. The example helper uses operator-authored policy and service
allowlists. No general-purpose command or credential API is exposed by the bridge.

Responses bind action, operation, target, exact plan, expiry, approval, and stable
execution identity. Only enrolled managed admission and signed completion evidence
can complete them. An interrupted or uncertain claim is never re-executed.
Read the existing execution record and reconcile from node evidence.
