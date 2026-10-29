# 0008. Web server, authentication, and the REST and SSE API

- Status: Accepted
- Date: 2026-10-29

## Context

Plan section 5.5 sketches `ohr-web`: Fastify, REST under `/api/v1`, an SSE
event stream, one admin account created with an installer token, argon2,
session cookies, a self-signed certificate, and login rate limiting. Building
it needs answers on where web keeps its own state, which argon2, how the
setup token reaches the user, how cross-site requests are stopped, and which
endpoints M3 ships.

## Decision

### Process and state

- `ohr-web` runs as the unprivileged system user `ohr` and reaches core only
  through the socket (decision 0007). It never runs an external command.
- Web keeps its own SQLite database, `/var/lib/ohr/web/web.db`, owned by
  `ohr`, for the admin account and sessions. Core never sees a password hash,
  and web never opens core's database.
- Fastify with `@fastify/static` for the UI build and `@fastify/cookie`.
  Request and response bodies use the zod schemas from `@ohr/shared`.

### Account and setup

- One admin account. Until it exists, every API route except
  `GET /api/v1/setup` and `POST /api/v1/setup` answers `409 setup-required`,
  and the UI shows the setup page.
- The package's `postinst` writes a 32-byte random setup token to
  `/var/lib/ohr/web/setup-token` (mode `0600`, owner `ohr`) and prints the URL
  and the token. `POST /api/v1/setup` takes the token, a username, and a
  password, creates the account, and deletes the file. Running
  `ohr-web setup-token` as root writes a fresh token, which is also how a
  forgotten password is reset.
- Passwords are hashed with argon2id from Node's built-in `node:crypto`
  (stable in Node 26), with 19 MiB of memory, 2 passes, and 1 lane, the
  OWASP minimum. No native module, as in decisions 0003 and 0006. Passwords
  are at least 12 characters.

### Sessions and request safety

- Login sets `ohr_session`: 32 random bytes, `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/`. The database stores only its SHA-256. Sessions
  expire after 7 days without use. Logout deletes the row.
- Every request that changes something must be `application/json` and carry
  an `Origin` header that matches the host it was sent to. With the strict
  cookie that rules out cross-site requests without a CSRF token.
- Login allows 5 failures per client address in 15 minutes, counted in
  memory, then answers `429` until the window passes.

### TLS

- HTTPS only, on port 7700, no plain HTTP listener. `postinst` creates a
  self-signed certificate with `openssl` in `/etc/ohr/tls/` for the host name
  and its addresses, valid for ten years, unless files are already there.
  Users replace the two files with their own and restart `ohr-web`.
- `ohr-web --insecure-http` exists for development and tests only, binds to
  localhost, and logs a warning.

### API in M3

- `auth`: login, logout, me. `setup`: status and create. `system`: version,
  kernel, tool versions. `drives`: list and detail. `pools`: list, detail
  with tiers, arrays, and members, `POST /pools/preview` and `POST /pools`.
  `volumes`: list per pool, preview and create. `jobs`: list and detail with
  steps and log. `events`: the SSE stream.
- Create endpoints mirror core's two calls: preview returns the refusal
  reasons or the input, layout, steps, commands, and state hash; create sends
  the input and the hash back. The UI asks the user to type the pool name
  before it calls create (plan section 5.6).
- `GET /api/v1/events` holds one core subscription per web process and fans
  it out to every open browser stream. It sends `state.changed`, job step,
  and job log events, plus a comment every 15 seconds so proxies keep the
  connection open.
- Expansion, spares, scrub, destroy, snapshots, and settings endpoints come
  with the milestones that build those features.

## Consequences

- A compromised web process can do what the API can do, which includes
  creating pools on empty drives, but cannot run arbitrary commands or read
  core's database.
- Anyone with root on the box can reset the admin password. That is the same
  trust boundary as the drives themselves.
- Self-signed certificates mean a browser warning on first visit. The setup
  page and the README explain it.
- The web database is a second file to back up. The config backup in M7
  covers both.
