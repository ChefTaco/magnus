# AGENTS.md - magnus-fleet-gateway

Read the repository root `AGENTS.md` first. Its privacy and secret rules apply here too.

`services/fleet-gateway` (`@hivemagnus/magnus-fleet-gateway`) carries the browser web terminal. An
authenticated browser user obtains a shell on a fleet node through this service, so treat every
change as security-sensitive. The README states the security model; keep it true. It ships as a
container image (`Dockerfile`) and is never published to npm.

## Rules

- The Magnus API must never hold this service's SSH key, and neither must a browser. (The deprecated
  standalone dashboard has its own terminal and `DASHBOARD_SSH_*` identity until it is removed.)
- A client names a node id and nothing else about its destination. Never accept a host, port,
  username, command or environment from a request. Schemas stay `.strict()`.
- The server only reads the host-key store. Never learn a key from a connection.
- Terminal input, output and bearer tokens are never logged or audited. The audit event type has no
  field for them; do not add one, and do not log `error.message` from SSH or upstream calls.
- Refusals are fixed codes and sentences in `src/errors.ts`.
- Every new refusal or limit gets a regression test. `npm test` uses a fake SSH channel;
  `npm run test:ssh` needs Docker and runs against a disposable sshd.
