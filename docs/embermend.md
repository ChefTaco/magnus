# Embermend bridge development preview

The optional Embermend integration owns security recommendations and product
permissions. Magnus owns inventory identity, one-way enrollment, supervised
execution, resource admission and signed receipts. The integration is disabled
unless the server has explicit product grants and the node has reviewed local
resource configuration. Existing node credentials are never exposed to Embermend.

`MAGNUS_EMBERMEND_GRANTS_JSON` binds a distinct hashed service credential to an
installation, product installation, stable logical targets, environments and
allowed versioned actions. It grants no console administration authority.
`MAGNUS_EMBERMEND_CONFIG` identifies a canonical root-controlled mode-0600 node
configuration. The node independently bounds file paths, modes, services, SSH
settings, protected firewall ports, Compose resources, security packages, scanner
images and worker/model access. Product parameters cannot introduce shell code.

The native capability endpoint advertises configured, implemented actions only.
Missing reboot policy, worker prerequisites, build or publication support remain
explicit blockers. Resource operations use
the supervised HTTP boundary. A retained small result digest binds the signed
completion to a separately retrieved bounded report. A queued product operation
is durable before native dispatch. Lost replies retain the original operation
and command identity; an unknown outcome never grants a second mutation or
establishes completion by loss of contact.

Repository tools use a dedicated rootless account, a bounded disposable tmpfs
checkout, immutable image, read-only runtime and restricted container controls.
Repository code receives no node, provider-write, model or management credentials.
Credentialed model calls and bounded GitHub reads are brokered outside that code.
Worker readiness, private repository access and hostile-repository acceptance
still require complete release proof.

The prospective 2.5.0 release notes own the additive operation migration.
Published 2.4.x release metadata stays unchanged; its version alone does not
establish this optional bridge. Hive requires an explicit protocol declaration
in the signed release. This source change does not publish a compatible release.
Bounded native reboot/cancellation and crash-adoption cases have actual disposable
proof; the complete native fault matrix and combined product acceptance remain
required before releasing the full remediation contract. See Embermend's
acceptance ledger for the product completion boundary.

The worker model configuration optionally sets `embermendBroker: true` for an
Embermend-owned inference broker. Both `model` and `ref` then select the exact
approved provider reference. The worker forwards the original operation ID and
source-disclosure policy outside the sandbox; repository output cannot supply
that context. Cloud-backed CLI providers require `local: false` and an admitted
remote-source grant. HTTPS is required across hosts; loopback broker HTTP does
not classify its backend as local. Direct approved local-model transport remains
supported. Completion model identity, terminal status and absence of tool calls
are checked before results return to the scanner. No CLI harness is added to
the node agent. See Embermend's inference guide for broker installation and pins.

Before dispatch, the Embermend handler now retains its original outer request,
lease fence and inner supervisor identity in protected durable state. Receipt
reads can adopt an exact successful terminal report after API-process loss
without replaying its worker. Missing, mismatched or truncated evidence keeps
ownership unknown; rootless work additionally requires container and workspace
mount absence. This supports same-operation observation after restart. It does
not infer completion across an unproven reboot or authorize another mutation.

A scanner broker using a private HTTPS CA can set optional `model.caFile`. The
node validates a canonical root-controlled regular CA file within a fixed byte
budget and uses it only for that model connection with certificate verification
enabled. The CA and broker token stay outside the repository container.

The worker `nodeExecutable` defaults to `/usr/bin/node`, as provided by the
pinned suite runtime. Only `/usr/bin/node` and `/usr/local/bin/node` are accepted
for an explicitly reviewed image. Preparation and source-reader entry commands
use that value; the validation profile must name an executable present in its
immutable image. Missing runtime paths fail rather than selecting another tool.

A scanner-only model failure returns a bounded error frame without provider
response data. Compatible scanner images retain the affected file as failed
analysis and report partial coverage, preserving other examined files. Source
reading and preparation cannot ask for model access. A closed scanner input
terminates the child and still follows independent worker cleanup.


Reboot is opt-in in the protected node configuration through `reboot` with a
`managementProbeId` and a bounded `continuationWindowSeconds` (60 to 900 seconds).
The request binds the current inventory `bootId`. The reviewed handler schedules
one reboot a minute ahead and durably retains systemd's exact mode, time and
operation marker acknowledgement. It does not release ownership on acceptance.
Adoption requires both a different kernel boot within the scheduled continuation
window and the previous boot's trusted logind shutdown event naming the exact
operation marker. The event binds root UID, executable, unit, transport, boot,
reboot mode and bounded shutdown time. Missing, ambiguous or unreadable persistent
journal evidence keeps ownership unknown. A cancelled schedule followed by an
unrelated reboot cannot complete the original operation. Same-boot agent restarts,
absent acknowledgements, changed requests and late boots also stay unknown. Receipt observation never schedules
another reboot, including after the original admission deadline. Operational
application health remains a separate verification.

The shutdown reader uses bounded, selected-field JSON from
[journalctl](https://www.freedesktop.org/software/systemd/man/255/journalctl.html).
Raw journal messages, unrelated process details and infrastructure fields are not
returned in the public receipt; it retains the validated shutdown proof digest.

Product job cancellation records intent and prevents further product dispatch.
It does not cancel an already accepted native shutdown, stop its owner or release
its lease. Observation may subsequently record the actual original reboot while
preserving the product cancellation flag and deadline. Cancelling or replacing a
host schedule is a separate owner intervention; its missing original shutdown
proof must remain visible. No automatic reboot retry is permitted.

Compose rollout uses a digest-qualified image and `--no-build --no-deps`, with a
bounded wait. Independent configuration inventory reports actual container IDs,
image identities, service/project labels, running state and Docker health. A
successful rollout receipt does not establish independent security verification.

Package inventory on nodes with configured `securityPackages` includes bounded
`packageActivation` evidence using `userspace-package-mappings.v1`. It compares
dpkg-owned canonical file device/inode identities with live process mappings,
retains process start ticks to detect PID replacement, and reports stale or
deleted mappings. It reads neither process arguments nor environment variables.
Installed package manifests are checked again before the observation completes.

The response declares requested packages, examined files/processes, failures and
its bounds: 32 packages, 4096 package paths, 8192 processes, 256 consumer records,
64 KiB of consumer evidence and a five-second inspection budget. Missing access,
new processes, changed package identities, unowned deleted mappings, unsupported
formats and truncation retain partial coverage. Package inventory propagates
that partial status. A disappearing process is recorded separately.

This method covers mappings of installed package files. Kernel and firmware
activation, cached interpreted code, effective configuration and external
consumers require their own capabilities and verification. The aggregate result
is named `no-stale-mappings-observed`, `stale-mappings-observed` or `unknown`;
operator verification must match that declared scope to the affected component.
Successful installation and absence of a vendor advisory remain independent of
the effective running state. Complete integrated acceptance remains pending.


## Explicit ownership settlement

`execution-settle.v1` is a controller capability advertised only for an explicitly
granted target with the existing separate reconciliation key and native signed
reconciliation support. It requires no node credential in Embermend and does not
need a replacement native agent or a new execution slot. The existing product
service credential remains bounded by its versioned target grant.

Embermend requires fresh independent technical evidence, a published exact plan,
a separate operator approval and scoped execution/recovery authority. The review
must establish that the original supported effect is quiescent before dispatch.
The controller additionally binds the original product operation, enrolled node,
native command, request digests and expired resource fence. Only expired unknown
reboot, Ubuntu OVAL and repository-scan owners are supported. Running work,
changed targets, other effects and missing ownership remain blocked.

The exact signed operator reconciliation decision is persisted before delivery.
After a lost reply, receipt reads adopt that same acknowledged decision without
another mutation. The recovery operation completes only after the original signed
native reconciliation is verified and its lease released. The original product
receipt remains unknown, with explicit ownership settlement and the original
historical uncertainty. Current-effect review never invents a successful reboot,
scan, exit code, security verification or campaign continuation. Active cleanup
and unattended settlement are outside this action's boundary.


If a recovery decision was retained but never acknowledged, another separately
approved decision may later settle that original native slot. The native ledger
accepts exactly one immutable reconciliation. Reading a different acknowledged
decision therefore establishes that the earlier recovery did not take effect;
the earlier recovery is marked failed and superseded, without rewriting either
decision or converting the original operation to success. Audit refusal occurs
before a new signed delivery decision is persisted.
