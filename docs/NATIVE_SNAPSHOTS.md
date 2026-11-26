# Stopped native profile snapshots

`magnus-agent native-snapshot` captures every managed Ardent profile discovered under the
configured `ARDENT_HOME`, including profiles created through Magnus after installation. It also
captures the shared `ARDENT_INSTALL_DIR`, runtime and reviewed extension receipts, model policy,
profile credentials, journals, workspace/artifacts, and exact generated user service files.
It requires root and privileged agent mode. This is a local recovery interface, not an HTTP route.

The caller must first hold the Control API's **reversible node admission fence**, with no held
work in any intersecting scope, and keep it until capture/restore and service resumption complete.
The product CLI does not acquire, release or modify that server fence. Do not substitute the
one-way Ardent rollback admission fence or enrollment drain. A consistent suite backup must freeze
native profiles before capturing the corresponding Magnus, HiveMem and other datastore state.
Online callers use this stopped native participant until a supported reversible live snapshot
protocol is available.

## Commands and protected storage

Use the same root-controlled environment file and installation directory as the native service.
Paths below are examples. Create a root-owned mode 0700 storage parent first; each session and
bundle directory must be new, separate, and outside both the native owner's home and agent install.
A state argument names a **directory**, containing the durable `journal.json`.

```bash
magnus-agent --env-file /opt/magnus-agent/.env native-snapshot inspect --json
magnus-agent --env-file /opt/magnus-agent/.env native-snapshot quiesce \
  --session "$SESSION_UUID" --state /var/lib/magnus-native-backups/session \
  --expected-inventory "$INVENTORY_SHA256"
magnus-agent --env-file /opt/magnus-agent/.env native-snapshot capture \
  --state /var/lib/magnus-native-backups/session --destination /var/lib/magnus-native-backups/bundle
magnus-agent --env-file /opt/magnus-agent/.env native-snapshot verify \
  --source /var/lib/magnus-native-backups/bundle
magnus-agent --env-file /opt/magnus-agent/.env native-snapshot resume \
  --state /var/lib/magnus-native-backups/session
```

The default manager unit is the installer's `magnus-agent.service`. Set `--agent-unit` on inspect
and quiesce for a custom installed unit; its working directory must bind to `AGENT_INSTALL_DIR`.
Custom user service bytes, service drop-ins, unsupported enablement, escaping links, special files,
foreign ownership, model assets and undeclared profile entries fail closed. Ordinary internal
relative runtime links are represented as inert manifest metadata until restoration.
Their complete declared graph is checked before restoration: links expand before later `..`
components, and escapes, dangling/cyclic links, non-directory traversal and more than forty
expansions are refused without dereferencing a target on the host.

All commands emit JSON. `inspect` returns `schemaVersion: 1`, `targetSha256`, `inventorySha256`,
`profiles[]`, service states, runtime receipt digest, work counts and complete file metadata.
The inventory digest binds every file's bytes and original UID/GID/mode, including configured
manager identity/evidence-key, TLS and environment hashes. Those manager files remain owned by
the installation backup; this profile interface never copies, regenerates or rewrites them.
Configured TLS certificate/key paths must be authorized by that root-controlled environment file.
TLS files can retain installation-operator ownership: ordinary files with one link, canonical protected
ancestry, no shared write permission, and mode 0600 for a private key. Manager configuration and
identity/evidence files remain root-owned. The retained binding includes original UID/GID/mode and
canonical path along with content, so metadata drift also refuses recovery. No TLS file is chowned.
The target digest binds the same host, configured non-root account and exact paths, independent
of profile membership. No secret value is printed, but paths and identifiers make reports private.

`quiesce` records original active and enabled states durably, reserves the manager, stops it, then
stops active profiles without disabling them. It checks successful service exit, empty cgroups,
absence of execution locks, stable inventory and unchanged profile membership/configuration.
A reservation also blocks accidental manager startup. Failure retains the reservation and journal.

`capture` verifies the stopped inventory pin, copies all declared trees into a new private bundle,
checks every payload digest and SQLite integrity, and checks the source inventory again before
success. Its response includes `manifestSHA256`, `inventorySha256`, `stoppedInventorySha256`,
`targetSha256`, `profiles[]` and `safety`. The caller must bind the whole bundle and manifest into
its outer archive's checksum/receipt. Keep that archive private. Bundle payload files are mode
0600 and directories 0700; their storage ownership is distinct from original restore metadata.
A private operator-owned archive copy can be verified, but never serves as mutable session state.

Automation may use `ACTION --request-file -` with bounded JSON on standard input instead of flags:

| Action | Request fields |
| --- | --- |
| `inspect` | optional `agentUnit` |
| `quiesce` | `session`, `state`, optional `agentUnit`, `expectedInventorySha256` |
| `recover-quiesce` | `state`, `session`, `expectedCurrent`, optional `expectedJournalSHA256` |
| `capture` | `state`, `destination` |
| `verify` | `source` |
| `restore` | `state`, `source`, `expectedCurrent` |
| `resume` | `state` |

Unknown actions/options fail before shutdown. Old agent versions without this interface must be
upgraded through their owning release before native snapshot coverage can be claimed.

## Restore and uncertain work

First verify the outer archive. Restore its owning manager identity/configuration/TLS context
while the admission fence and native services remain stopped; this CLI refuses a different retained
manager binding. Inspect and quiesce the current native target into a new session. Use that
session's `stoppedInventorySha256` as the explicit current-state pin:

```bash
magnus-agent --env-file /opt/magnus-agent/.env native-snapshot restore \
  --state /var/lib/magnus-native-backups/restore-session \
  --source /var/lib/magnus-native-backups/bundle --expected-current "$STOPPED_INVENTORY_SHA256"
```

Restore validates all nested inventory, payload bytes, SQLite integrity, runtime/extension receipts,
profile identities and generated unit bytes without importing the captured runtime or starting it.
It stages and validates **all** trees before the first promotion. A missing profile can be recovered;
profiles/units created after the snapshot are retained in previous checkpoints when replaced.
Source user-unit enablement is restored explicitly. The manager unit's enablement must already
match its owning installation. Original paths/UIDs/GIDs/modes are restored from the manifest,
not inferred from archive staging. Previous trees/files and promotion phases remain recoverable.
Partial promotion leaves a held journal; it is never automatically replayed or rolled forward.

`resume` starts only services that were active in the recorded source state, and does not change
enablement. It refuses pending, uncertain or unrecognized state rows, retained execution locks,
unclean shutdown, changed inventory, or an incomplete/held session. This matters because normal
Ardent startup can resume queued management tasks and job consumers. Unknown tasks, deliveries
and job receipts are preserved exactly; capture/verify do not convert them to success, clear them,
or run any task, model, tool, plugin or job handler. Reconcile exact evidence through its owning
product before activation. Never delete an owner lock or edit a snapshot journal to force resume.

The interface supports a same-host, same-account recovery. Cross-host relocation, unmanaged
profile owners, external plugin paths and model downloads need a separate supported migration.

Configured plugin modules and reviewed extension packages are retained, but this first snapshot
contract does not declare an extension startup capability. A nonempty `plugins` array therefore
blocks automatic activation, as do unknown/private SQLite tables or unsupported status schemas.
Core HiveMem memory configuration is part of Ardent itself and does not require a plugin module.
The inspector recognizes `.sqlite`, `.sqlite3`, `.db` and extensionless SQLite headers. Which tables
and states count as work is Ardent's journal policy (`@hivemagnus/ardent/journal`, the same rules as
`ardent journal status`), from the Ardent release Magnus pins: task and job states, A2A
serialized/indexed status, child settlement flushes, unbound admission/delivery records and the
admission fence. A table, column or state value that policy does not classify counts as unsupported,
and the agent refuses a policy version other than 1. It never imports archived modules to obtain a
stronger claim.

## Explicit recovery of a refused initial quiescence

SQLite `readOnly` alone can still create or modify WAL/SHM sidecars. Journal inspection therefore
uses a private byte-verified copy of the database and matching WAL, including committed work not
yet checkpointed into the main file. The source SHM is never opened by SQLite. Source hashes and
WAL membership must remain stable; the private copy is removed after the check.

A session held specifically because its first two stopped inventories differed can be reconsidered
through an explicit root-owned recovery request while the original caller admission fence remains
held. This is restricted to an initial quiescence that has never captured or promoted data:

```bash
magnus-agent --env-file /opt/magnus-agent/.env native-snapshot recover-quiesce \
  --state /var/lib/magnus-native-backups/session --session "$SESSION_UUID" \
  --expected-current "$STOPPED_INVENTORY_SHA256" --expected-journal "$FAILED_JOURNAL_SHA256"
```

The exact reservation, session and target must match. Two fresh stopped inventories must equal
the explicit pin; services must be clean and empty, with unchanged enablement. Profile membership,
configuration, non-journal data, runtime, generated units, manager bindings and retained work counts
must match the original session. Recovery preserves the exact old failed journal under the private
`state/history` directory and retains its failure in the new journal. Its JSON receipt includes
`previousJournalSHA256`, `journalSHA256`, `historyPath`, `historySHA256`, `session`, `targetSha256`
and `stoppedInventorySha256`. It only transitions that session to stopped; it does not capture,
start services, release the caller fence or replay any work. An owning suite recovery flow may
then resume the original clean states and release its exact fence, preserving the failed backup
receipts. A later normal backup is a new operation, never a claim that the failed backup succeeded.
