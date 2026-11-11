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

The native capability endpoint advertises implemented actions only. Unsupported
reboot, build and publication requests remain blockers. Resource operations use
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

The prospective 2.4.0 release notes own the additive operation migration. This
source change does not publish a compatible release. Reboot continuation, integrated crash-adoption fault injection, complete cancellation and combined product acceptance remain
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
Only a different kernel boot within the scheduled continuation window can adopt
the original operation; a same-boot agent restart, absent acknowledgement, changed
request or late unrelated boot stays unknown. Receipt observation never schedules
another reboot, including after the original admission deadline. Operational
application health remains a separate verification.

Compose rollout uses a digest-qualified image and `--no-build --no-deps`, with a
bounded wait. Independent configuration inventory reports actual container IDs,
image identities, service/project labels, running state and Docker health. A
successful rollout receipt does not establish independent security verification.
