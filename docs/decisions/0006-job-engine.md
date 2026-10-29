# 0006. Job engine and database

- Status: Accepted
- Date: 2026-10-29

## Context

Milestone M2 needs the job engine from plan section 5.4: structural changes
run as a list of steps with preconditions, survive a daemon restart, and
show a preview before anything is written. Three things had to be fixed
before the first job could exist: how jobs are stored, what a step is, and
how the preview is tied to the state it was made from.

## Decision

### Database

- SQLite through Node's built-in `node:sqlite` module, not the
  `better-sqlite3` package the plan named. Node 26 ships the module as
  stable, it has the same synchronous API, and it means the root daemon
  carries no native module to build or bundle into the `.deb`. The same
  reasoning picked `execFile` over `execa` in decision 0003.
- The database lives at `/var/lib/ohr/ohr.db` in WAL mode. Tests use an
  in-memory database or a file in a temporary directory.
- The schema carries a version number. Migrations run when the store opens.

### Jobs and steps

- A job is a kind (`pool-create`, `volume-create`, more later), a pool id,
  an input document, a state hash, a status, and a list of steps. Jobs are
  `pending`, `running`, `done`, or `failed`. Steps are `pending`, `running`,
  `done`, `skipped`, or `failed`.
- The input document is enough to rebuild the job's step list, so the code
  that defines a kind is a pure function from input to steps. The database
  stores the input and each step's status, never code.
- A step has a name that is stable within the job, a description, the
  commands it will run (for the preview), a precondition, an action, and a
  postcondition. The precondition answers `ready`, `already-done`, or
  `blocked` with a reason. The engine runs it right before the action, every
  time.
- The engine runs steps in order from the first step that is not `done` or
  `skipped`. `already-done` marks the step `skipped` and moves on, which is
  what makes a job resumable after a crash between an action finishing and
  its status being written. `blocked` or any error fails the job at that step
  and leaves every later step `pending`. Nothing is undone (safety rule 8).
- On start, the daemon resumes every `pending` or `running` job from its
  first incomplete step.
- At most one job per pool may be `pending` or `running`. The database
  enforces it with a partial unique index, so two callers cannot both win.
- Each job keeps a log of lines, each tied to a step, which later streams to
  the UI.

### Preview and the state hash

- A preview is the step list with each step's commands, computed from the
  input without touching the system.
- The state hash is a SHA-256 of the parts of the system snapshot a job
  depends on: each physical drive's path, serial, WWN, size, role, and
  partition count, plus the names of md arrays, volume groups, logical
  volumes, and mount targets. It is computed at preview time and stored with
  the job. Before running, the engine computes it again; a difference means
  the machine changed since the user confirmed, and the job is rejected
  without running anything (safety rule 4).

## Consequences

- Any job kind is a pure step builder plus executors, which keeps the engine
  small and lets unit tests drive it with fake steps.
- A step must be written so that its precondition can tell its work is
  already done from live state. That is a discipline every new step follows,
  and the integration tests exercise it by re-running jobs.
- Progress inside a long step, such as a reshape, is not modelled yet. The
  monitor in M5 reads it from the kernel; the job only waits.
- `node:sqlite` is newer than `better-sqlite3`. If it turns out to lack
  something, swapping is a change to one module, the store.
