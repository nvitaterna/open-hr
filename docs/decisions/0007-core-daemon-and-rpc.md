# 0007. Core daemon, RPC protocol, and the CLI as a client

- Status: Accepted
- Date: 2026-10-29

## Context

In M2 the CLI imports `@ohr/core` and runs the job engine in its own process
as root. Plan section 5.1 puts every privileged action in one root daemon,
`ohr-core`, behind a typed RPC API on `/run/ohr/core.sock`, with the web
server and the CLI as its only clients. Milestone M3 builds that split, which
leaves four questions: the wire protocol, who may connect, where the checks
that the CLI makes today belong, and how a client follows a running job.

## Decision

### Wire protocol

- Newline-delimited JSON over the unix socket. Each line is one message of at
  most 1 MiB. A longer line closes the connection.
- A request is `{"id": <n>, "method": "<name>", "params": {...}}`. A reply is
  `{"id": <n>, "result": ...}` or
  `{"id": <n>, "error": {"code": "<code>", "message": "..."}}`. An event the
  client subscribed to is `{"event": "<name>", "data": {...}}` with no id.
- Requests on one connection may overlap. Replies carry the request's id.
- A new package, `@ohr/rpc`, holds the contract, the framing, the client, and
  the server transport. It runs in Node only, which is why it is not part of
  `@ohr/shared`. The contract lists every method with a zod schema for its
  params and its result, and every event with a schema for its data; it
  reuses the schemas in `@ohr/shared` for snapshots, plans, and jobs.
  Core validates params against the contract and rejects anything else with
  `invalid-params` before a handler runs. Clients validate results the same
  way. Adding a method means adding it to the contract first.
- Error codes are a closed list in the contract: `invalid-params`,
  `not-found`, `conflict` (another job holds the pool), `state-changed` (the
  state hash no longer matches), `rejected` (a safety check said no, with the
  reasons), and `internal`.
- The client and server are written on `node:net` with no dependency. JSON-RPC
  2.0 was considered; its batch and notification rules add nothing here, and
  HTTP over the socket would duplicate the REST layer that `ohr-web` already
  provides.

### Who may connect

- Core creates the socket itself, owned by `root:ohr` with mode `0660`, in
  `/run/ohr` (mode `0750`, group `ohr`). Membership of the `ohr` group is
  equivalent to administrator rights over every pool, and the docs say so.
- Root and the `ohr-web` service user are the expected clients. There is no
  second authentication on the socket; web authenticates people, the socket
  authenticates processes by file permission.

### Checks move into core

- Everything that decides whether a job may run lives in core, so the CLI and
  the browser cannot disagree: drive eligibility (system drive, signatures and
  the wipe flag, unknown paths), pool id collisions, the planner call, and
  building the job input including new UUIDs.
- A structural change is two calls. `pools.previewCreate` (and
  `volumes.previewCreate`) takes what the user chose and returns either the
  reasons it is refused or the job input, the planned layout, the step list
  with commands, and the state hash. `jobs.submit` takes the kind, the input,
  and the state hash. Core checks the input again against live state, stores
  the job, and starts it. A hash that no longer matches is `state-changed`
  (safety rule 4).
- Core runs jobs, one per pool as decision 0006 already enforces, and resumes
  unfinished jobs when it starts.

### Following a job

- `events.subscribe` on a connection starts the stream of events for that
  connection: job step and log events, and `state.changed` when the system
  snapshot changes. A filter limits it to one job.
- A client that disconnects does not stop a job. `ohr pool create` follows the
  job until it ends, and Ctrl-C only stops following; `ohr job show <id>`
  picks it up again.
- Core rereads the system snapshot after every job step, on udev block events
  (from a `udevadm monitor` child process, debounced), and on a timer.
  Clients ask for the cached snapshot with `system.state`.

### The CLI

- `@ohr/cli` depends on `@ohr/shared` and `@ohr/rpc`, never on `@ohr/core`.
  Every command except `version` and the pure `plan --sizes` form talks to
  core. If the socket is missing the
  CLI says that `ohr-core` is not running and exits; it never falls back to
  running jobs itself.
- `ohr-core` takes `--socket` and `--database`, so tests and
  `scripts/reboot-check.sh` run a private daemon on loop devices without
  touching an installed one.

## Consequences

- One place decides what is safe, and both front ends get the same answer and
  the same error text.
- The contract module is the API surface to review in every PR that touches
  core. A schema there is also the documentation of the method.
- The CLI loses the ability to work with core stopped. That is deliberate:
  two writers to the same pools and database is the failure this split
  prevents.
- The protocol has no versioning beyond the package version. Core, web, and
  CLI always ship together in one `.deb`, so they cannot drift. If a
  third-party client ever matters, that is a new decision.
