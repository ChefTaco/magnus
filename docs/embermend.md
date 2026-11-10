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
