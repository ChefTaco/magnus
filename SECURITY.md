# Security Policy

## Supported versions

Security fixes are released for the latest `1.x` version of each `@hivemagnus/magnus-*` package and
`@hivemagnus/ardent`.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Report them privately through
[GitHub private vulnerability reporting](https://github.com/ChefTaco/magnus/security/advisories/new).
Please include:

- the affected package (UI, Server, Agent, Ardent, Skills or Contracts) and version or commit
- steps to reproduce, or a proof of concept
- the impact you expect

You should get an acknowledgement within a few days. Once a fix is available, a GitHub security
advisory will credit you unless you ask not to be named.

## Hardening notes for operators

- Serve the UI, the server and every agent over TLS, and keep them on a private network.
- The agent runs commands on its host for the server. Give each node its own token, and restrict
  who can reach the agent port.
- Keep `.env` files and TLS keys readable only by root or the service user.
- Keep `API_SECRET` and the other server secrets out of browser bundles and logs. The UI injects
  them server-side only.
