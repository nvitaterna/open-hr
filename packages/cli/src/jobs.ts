/** What every job-running command shares: the preview, the confirmation, and running the job. */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type JobDefinition,
  type JobEvent,
  previewJob,
  runJob,
  submitJob,
} from '@ohr/core/jobs/engine';
import { JobConflictError } from '@ohr/core/jobs/job-conflict-error';
import { systemStateHash } from '@ohr/core/jobs/state-hash';
import { JobStore } from '@ohr/core/jobs/store';
import { readSystemState, type SystemSnapshot } from '@ohr/core/system-state';
import type { JobRecord } from '@ohr/shared/jobs';

import { EXIT_FAILURE, EXIT_OK, type Io } from './io.ts';

const INDENT = '  ';

function progressLine(event: JobEvent, total: number): string | null {
  if (event.kind === 'step') {
    if (event.status === 'running') {
      return `[${event.index + 1}/${total}] ${event.name}`;
    }
    if (event.status === 'failed') {
      return `[${event.index + 1}/${total}] ${event.name}: failed: ${event.error ?? ''}`;
    }
    return `[${event.index + 1}/${total}] ${event.name}: ${event.status}`;
  }
  if (event.kind === 'log') {
    return `${INDENT}${event.line}`;
  }
  return null;
}

export interface JobRun {
  readonly definition: JobDefinition;
  /** The snapshot the preview was made from. */
  readonly snapshot: SystemSnapshot;
  readonly database: string;
  /** What the job makes, for the final message, such as "Pool p1" or "Volume data". */
  readonly subject: string;
}

/** Prints the numbered step list with each step's commands. */
export function printSteps(io: Io, definition: JobDefinition): void {
  io.stdout('Steps');
  for (const [index, step] of previewJob(definition).steps.entries()) {
    io.stdout(`${INDENT}${index + 1}. ${step.name}`);
    for (const command of step.commands) {
      io.stdout(`${INDENT}${INDENT}${command}`);
    }
  }
}

/** Asks the user to type `expected` back. True when they did, or when `yes` skipped the question. */
export async function confirmed(
  io: Io,
  what: string,
  expected: string,
  yes: boolean,
): Promise<boolean> {
  if (yes) {
    return true;
  }
  const typed = await io.confirm(`Type the ${what} (${expected}) to continue: `);
  if (typed.trim() === expected) {
    return true;
  }
  io.stderr('Cancelled. Nothing was changed.');
  return false;
}

/** Stores and runs the job, printing progress, and returns the exit code. */
export async function runConfirmedJob(io: Io, job: JobRun): Promise<number> {
  await mkdir(dirname(job.database), { recursive: true });
  const store = JobStore.open(job.database);
  try {
    let record: JobRecord;
    try {
      record = submitJob(store, job.definition, systemStateHash(job.snapshot));
    } catch (error) {
      if (error instanceof JobConflictError) {
        io.stderr(error.message);
        return EXIT_FAILURE;
      }
      throw error;
    }
    const current = await readSystemState({
      run: io.run,
      readFile: io.readFile,
      includeSmart: false,
    });
    const total = job.definition.steps.length;
    const finished = await runJob(store, job.definition, record.id, {
      run: io.run,
      stateHash: systemStateHash(current),
      listener: (event) => {
        const line = progressLine(event, total);
        if (line !== null) {
          io.stdout(line);
        }
      },
    });
    if (finished.status === 'done') {
      io.stdout(`${job.subject} created. Job ${finished.id}.`);
      return EXIT_OK;
    }
    io.stderr(
      `${job.subject} was not created: ${finished.error ?? finished.status}. Job ${finished.id}.`,
    );
    io.stderr('Nothing was undone. Fix the cause and run the same command again to resume.');
    return EXIT_FAILURE;
  } finally {
    store.close();
  }
}
