/**
 * Persists jobs in SQLite through node:sqlite (decision 0006). The store is
 * the daemon's memory of what it was doing: on start it reads back every
 * unfinished job and the engine resumes it. One active job per pool is
 * enforced here, by the database, so two callers cannot both win.
 */

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  type JobKind,
  type JobRecord,
  type JobStatus,
  jobRecordSchema,
  type LogLine,
  logLineSchema,
  type StepRecord,
  type StepStatus,
  stepRecordSchema,
} from '@ohr/shared/jobs';

import { JobConflictError } from './job-conflict-error.ts';

const IN_MEMORY = ':memory:';
const SCHEMA_VERSION = 1;
const UNIQUE_VIOLATION_CODE = 2067;
const UNIQUE_VIOLATION_MESSAGE = 'UNIQUE constraint failed';

const SCHEMA = `
create table if not exists schema_version (version integer not null);
create table if not exists jobs (
  id text primary key,
  kind text not null,
  pool_id text not null,
  status text not null,
  input_json text not null,
  state_hash text not null,
  created_at text not null,
  started_at text,
  finished_at text,
  error text
);
create unique index if not exists jobs_one_active_per_pool
  on jobs (pool_id) where status in ('pending', 'running');
create table if not exists job_steps (
  job_id text not null references jobs (id),
  idx integer not null,
  name text not null,
  description text not null,
  commands_json text not null,
  status text not null,
  started_at text,
  finished_at text,
  error text,
  primary key (job_id, idx)
);
create table if not exists job_log (
  id integer primary key autoincrement,
  job_id text not null references jobs (id),
  step_idx integer,
  at text not null,
  line text not null
);
`;

const SELECT_JOB = `select id, kind, pool_id as poolId, status, input_json as inputJson,
  state_hash as stateHash, created_at as createdAt, started_at as startedAt,
  finished_at as finishedAt, error from jobs`;

const SELECT_STEPS = `select idx as "index", name, description, commands_json as commandsJson,
  status, started_at as startedAt, finished_at as finishedAt, error
  from job_steps where job_id = ? order by idx`;

const SELECT_LOG = 'select step_idx as step, at, line from job_log where job_id = ? order by id';

/** node:sqlite raises a plain Error with SQLite's extended code; 2067 is SQLITE_CONSTRAINT_UNIQUE. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { errcode?: unknown }).errcode;
  return code === UNIQUE_VIOLATION_CODE || error.message.includes(UNIQUE_VIOLATION_MESSAGE);
}

function toStep(row: unknown): StepRecord {
  const raw = row as { commandsJson: string } & Record<string, unknown>;
  return stepRecordSchema.parse({ ...raw, commands: JSON.parse(raw.commandsJson) });
}

export interface NewStep {
  readonly name: string;
  readonly description: string;
  readonly commands: readonly string[];
}

/** The shape a job has before it is stored. */
export interface NewJob {
  readonly kind: JobKind;
  readonly poolId: string;
  readonly input: unknown;
  readonly stateHash: string;
  readonly steps: readonly NewStep[];
}

export class JobStore {
  readonly #db: DatabaseSync;
  readonly #now: () => string;

  private constructor(db: DatabaseSync, now: () => string) {
    this.#db = db;
    this.#now = now;
  }

  /** Opens or creates the database at `path`, or in memory for ":memory:". */
  static open(path: string, now: () => string = () => new Date().toISOString()): JobStore {
    const db = new DatabaseSync(path);
    if (path !== IN_MEMORY) {
      db.exec('pragma journal_mode = wal');
    }
    db.exec('pragma foreign_keys = on');
    db.exec(SCHEMA);
    const version = db.prepare('select version from schema_version').get();
    if (version === undefined) {
      db.prepare('insert into schema_version (version) values (?)').run(SCHEMA_VERSION);
    }
    return new JobStore(db, now);
  }

  close(): void {
    this.#db.close();
  }

  /** Stores a new pending job. Throws JobConflictError if the pool has one already. */
  createJob(job: NewJob): JobRecord {
    const id = randomUUID();
    const createdAt = this.#now();
    this.#db.exec('begin');
    try {
      this.#db
        .prepare(
          `insert into jobs (id, kind, pool_id, status, input_json, state_hash, created_at)
           values (?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(id, job.kind, job.poolId, JSON.stringify(job.input ?? null), job.stateHash, createdAt);
      const insertStep = this.#db.prepare(
        `insert into job_steps (job_id, idx, name, description, commands_json, status)
         values (?, ?, ?, ?, ?, 'pending')`,
      );
      for (const [index, step] of job.steps.entries()) {
        insertStep.run(id, index, step.name, step.description, JSON.stringify(step.commands));
      }
      this.#db.exec('commit');
    } catch (error) {
      this.#db.exec('rollback');
      if (isUniqueViolation(error)) {
        throw new JobConflictError(`Pool ${job.poolId} already has a job that is not finished`, {
          cause: error,
        });
      }
      throw error;
    }
    return this.requireJob(id);
  }

  getJob(id: string): JobRecord | null {
    const row = this.#db.prepare(`${SELECT_JOB} where id = ?`).get(id);
    if (row === undefined) {
      return null;
    }
    return this.toJob(row);
  }

  /** Every job, newest first. */
  listJobs(): JobRecord[] {
    return this.#db
      .prepare(`${SELECT_JOB} order by created_at desc, id`)
      .all()
      .map((row) => this.toJob(row));
  }

  /** Jobs to resume on start, oldest first. */
  unfinishedJobs(): JobRecord[] {
    return this.#db
      .prepare(`${SELECT_JOB} where status in ('pending', 'running') order by created_at, id`)
      .all()
      .map((row) => this.toJob(row));
  }

  /** Moves a job to `status`, stamping the start or finish time as appropriate. */
  setJobStatus(id: string, status: JobStatus, error: string | null = null): JobRecord {
    const now = this.#now();
    if (status === 'running') {
      this.#db
        .prepare(
          'update jobs set status = ?, error = null, started_at = coalesce(started_at, ?) where id = ?',
        )
        .run(status, now, id);
    } else if (status === 'done' || status === 'failed') {
      this.#db
        .prepare('update jobs set status = ?, error = ?, finished_at = ? where id = ?')
        .run(status, error, now, id);
    } else {
      this.#db.prepare('update jobs set status = ?, error = ? where id = ?').run(status, error, id);
    }
    return this.requireJob(id);
  }

  setStepStatus(id: string, index: number, status: StepStatus, error: string | null = null): void {
    const now = this.#now();
    if (status === 'running') {
      this.#db
        .prepare(
          `update job_steps set status = ?, error = null, started_at = coalesce(started_at, ?)
           where job_id = ? and idx = ?`,
        )
        .run(status, now, id, index);
    } else if (status === 'pending') {
      this.#db
        .prepare('update job_steps set status = ?, error = ? where job_id = ? and idx = ?')
        .run(status, error, id, index);
    } else {
      this.#db
        .prepare(
          'update job_steps set status = ?, error = ?, finished_at = ? where job_id = ? and idx = ?',
        )
        .run(status, error, now, id, index);
    }
  }

  appendLog(id: string, step: number | null, line: string): void {
    this.#db
      .prepare('insert into job_log (job_id, step_idx, at, line) values (?, ?, ?, ?)')
      .run(id, step, this.#now(), line);
  }

  logLines(id: string): LogLine[] {
    return this.#db
      .prepare(SELECT_LOG)
      .all(id)
      .map((row) => logLineSchema.parse(row));
  }

  private requireJob(id: string): JobRecord {
    const job = this.getJob(id);
    if (job === null) {
      throw new Error(`Job ${id} is not in the store`);
    }
    return job;
  }

  private toJob(row: unknown): JobRecord {
    const raw = row as { id: string; inputJson: string } & Record<string, unknown>;
    const steps = this.#db.prepare(SELECT_STEPS).all(raw.id).map(toStep);
    return jobRecordSchema.parse({ ...raw, input: JSON.parse(raw.inputJson), steps });
  }
}
