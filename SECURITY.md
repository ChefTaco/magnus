# Security Policy

## Supported versions

Security fixes are released for the latest major version (currently `3.x`) of each `@hivemagnus/magnus-*` package
and the `ghcr.io/cheftaco/magnus-*` images.
Ardent (`@hivemagnus/ardent`) has its own repository and
[security policy](https://github.com/ChefTaco/Ardent/security/policy); report Ardent vulnerabilities there.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report them privately through
[GitHub private vulnerability reporting](https://github.com/ChefTaco/magnus/security/advisories/new).
Please include:

- the affected package (UI, Server, Fleet gateway, Agent, Installer, Skills or Contracts) and version or commit
- steps to reproduce, or a proof of concept
- the impact you expect

You should get an acknowledgement within a few days. Once a fix is available, a GitHub security
advisory will credit you unless you ask not to be named.

## Hardening notes for operators

- Serve the UI, the server and every agent over TLS, and keep them on a private network.
- The agent runs commands on its host for the server. Enroll each node with its own key (one-time
  enrollment token), keep `NODE_AUTH_MODE` at its default `enforce`, and restrict who can reach the
  agent port. See [per-node credentials](docs/NODE_CREDENTIALS.md).
- Keep `.env` files and TLS keys readable only by root or the service user.
- Keep `API_SECRET` and the other server secrets out of browser bundles and logs. The UI injects
  them server-side only.
