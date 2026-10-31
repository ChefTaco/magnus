# Finite managed cron candidate

This component is opt-in. Ordinary `/cron/sync` remains available only through
legacy admission. It writes legacy entries and is an explicit drain blocker.
`/cron/managed-sync` installs only the fixed runner and an immutable private job
record. Installing the wrapper does not activate the supervisor feature flag.
All production flags and schedules remain unchanged by this implementation.

An administrator authorizes an existing CronJob with `POST /cron/:id/managed`:
`{revision, timezone:"UTC", timeoutSeconds:1..3600, expiresAt:<epoch-ms>}`.
The API snapshots the exact current command, arguments, working directory and
environment. The API-owned revision, canonical node FQDN and job name determine
its identity. Registration returns `synced:false` if node installation fails;
an explicit repeat retries installation only. New execution requires completed
resource enrollment and the existing supervisor feature enabled.

The fixed cron entry wakes every minute with a clean environment. The installed
runner loads its own mandatory `.env`, verifies the UTC numeric five-field
schedule, writes a durable minute occurrence, and requests fresh API authority.
A single-number step such as `5/15` is unsupported and rejected; explicit ranges
and wildcard steps work. The occurrence deadline is the earlier of the absolute
job expiry and the scheduled minute plus its explicitly authorized timeout.
Delays consume that budget. Nothing creates a replacement budget or deadline.

The existing RemoteCommand, node resource fence, CommandLedger and
ExecutionSupervisor own actual execution. Every occurrence is single-use. A
lost admission, launch or requester acknowledgment retains uncertainty. Recovery
observes the original supervisor execution and adopts only its signed completion;
it never invokes the original command again. Result settlement is idempotent.
Administrative revision, pause and delete revoke future authority under the same
node lock. The final dispatch transaction is the acceptance boundary: later
changes do not terminate already accepted work or claim that its effects ended.

`GET /cron/managed-inventory` returns hashes/counts and bounded managed metadata.
Foreign/raw crontabs, system cron sources, timers, native Hermes jobs, unreadable
sources and unexplained private journal files block quiescence. User timer
inventory is independently observed for every discovered account. A root daemon's inventory must cover its
root/all-user sources; deployment-user crontab inspection is insufficient.
Existing native Hermes schedules are never silently migrated, paused or given a
new expiration. Scheduler acknowledgment is conditional on the candidate drain protocol below; global enrollment still requires every participant.

Receipts are retained. The current bounded inventory cap is 4096 journal entries;
exceeding it fails closed and requires explicit retention/reconciliation work.
No unsettled receipt is expired or deleted automatically. This is a follow-on
operational limitation for dense long-lived schedules.

Verification uses bounded process, concurrency, restart and disposable
PostgreSQL fixtures, including one actual finite local process through the API
admission and existing supervisor/ledger recovery path with a controlled systemd
backend. This does not claim production systemd activation, live job migration,
public enrollment completion or multi-hour/endurance acceptance. Those tests
remain deferred; no production schedules or services are changed by the tests.

## Scheduler drain participation (candidate)

The fixed node endpoint `POST /cron/enrollment-drain` accepts only the existing
API-owned scheduler challenge. It authenticates the node caller, obtains a fresh
nonce-bound `/resource-leases/enrollment/scheduler-status` response, and persists
its exact node/epoch/barrier identity under the same kernel lock used by trigger
claims and schedule installation. A restart retains that barrier. Raw and
managed schedule sync cannot cross it; already recorded occurrences may only
recover their original receipts. The endpoint never starts a replacement task.

The signed `magnus.resource-enrollment.v1` receipt is conditional: all observed
sources must be supported, all owned work settled, and repeated source/ownership
snapshots stable. Otherwise the response is pending or unavailable. Foreign
claims are never expired by age or presumed dead from a missing PID. The API
also checks central unresolved occurrences before accepting a scheduler receipt.
This does not remove the independent agent/API/dashboard enrollment requirements.

Discovery now examines NSS accounts, existing user-manager timer observations,
global and per-account timer unit trees (including inactive users), runtime unit
trees, default and named Hermes profile stores, observed/configured custom
Hermes homes, anacron and at sources. It does not start user managers, suppress OS
schedules, pause Hermes jobs, or convert foreign work. Unreadable/ambiguous sources
remain blockers. An observed Hermes runtime without an instrumented execution
ledger is itself a blocker even when its current job list is empty.

An optional private, root-owned `scheduler-coverage.json` in the scheduler
journal can add otherwise undiscoverable roots only:

```json
{"version":1,"reviewRef":"operator-reviewed-change-reference","additionalHermesHomes":["/absolute/canonical/hermes-home"]}
```

Paths must be bounded, canonical existing directories; exclusions and allowlists
are rejected. This is a location-discovery contract, not action authorization or
a claim that foreign work stopped. Discovered custom roots and foreign source digests are retained in the same
private scheduler journal. Removing a location declaration, job file or process
does not settle that observed work; only a future reviewed owner-adapter
settlement contract can discharge it. No generic clear/expiry endpoint exists. Inactive custom homes with no discoverable
trigger remain an explicit coverage limit requiring operator review.

A foreign scheduler migration must be separately opted into with a plan binding
the exact source digest, owner/profile, original enabled state and schedule,
finite destination definition/revision, and all outstanding execution receipt
IDs. The source owner must prove settlement and fence future dispatch before
activating the destination. Rollback must revoke destination admission and settle
its outstanding work before restoring the exact original definition; it may not
run both or replay an uncertain occurrence. No migration or rollback is executed
by inventory or drain. Existing foreign schedules continue normally until such
a reviewed adapter is available. Bounded fixtures prove the positive managed-only
path; they do not establish production enrollment or endurance acceptance.

After a successful future enrollment, the fixed node-authenticated scheduler-status
read (fresh nonce, exact node/epoch/barrier identity) may persist `enrolled.json`.
This observation reopens only managed definitions and triggers; the original
`drain.json` remains and raw scheduling stays denied after restart. Every managed
occurrence still needs fresh canonical API admission and signed finite execution
authority. API unavailability cannot authorize work, and original receipt recovery
remains available. Re-draining an already enrolled identity is rejected; another
enrollment epoch requires a separately reviewed transition protocol. No endpoint
accepts a caller-provided enrollment assertion or clears the barrier.
