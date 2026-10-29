/**
 * What every job command shares: printing the steps, the confirmation, and
 * following a job that ohr-core runs (decision 0007). The job runs in core,
 * so Ctrl-C only stops following it.
 */

import type { RpcEvent } from '@ohr/rpc/contract';
import { isFinished, type JobRecord, type JobStatus, type LogLine } from '@ohr/shared/jobs';

import { type Core, EXIT_FAILURE, EXIT_OK, type Io } from './io.ts';

const INDENT = '  ';

interface PreviewStep {
  readonly name: string;
  readonly commands: readonly string[];
}

function progressLine(event: RpcEvent, total: number): string | null {
  if (event.event === 'job.step') {
    const { index, name, status, error } = event.data;
    const position = `[${index + 1}/${total}] ${name}`;
    if (status === 'running') {
      return position;
    }
    if (status === 'failed') {
      return `${position}: failed: ${error ?? ''}`;
    }
    return `${position}: ${status}`;
  }
  if (event.event === 'job.log') {
    return `${INDENT}${event.data.line}`;
  }
  return null;
}

function eventJobId(event: RpcEvent): string | null {
  if (event.event === 'state.changed') {
    return null;
  }
  return event.data.jobId;
}

/** How a job that was followed ended, or that the user stopped following it. */
type Outcome = JobStatus | 'detached';

interface Ending {
  readonly subject: string;
  readonly jobId: string;
  readonly outcome: Outcome;
}

async function report(io: Io, core: Core, { subject, jobId, outcome }: Ending): Promise<number> {
  if (outcome === 'detached') {
    io.stderr(`Stopped following job ${jobId}. It keeps running in ohr-core.`);
    io.stderr(`Follow it again with: ohr job show --follow ${jobId}`);
    return EXIT_FAILURE;
  }
  if (outcome === 'done') {
    io.stdout(`${subject} created. Job ${jobId}.`);
    return EXIT_OK;
  }
  const { job } = await core.call('jobs.get', { id: jobId });
  io.stderr(`${subject} was not created: ${job.error ?? job.status}. Job ${jobId}.`);
  io.stderr(`Nothing was undone. Fix the cause, then run: ohr job retry ${jobId}`);
  return EXIT_FAILURE;
}

export interface FollowedJob {
  /** What the job makes, for the final message, such as "Pool p1" or "Volume data". */
  readonly subject: string;
  /** Starts the job, or picks up an existing one, and returns its record. */
  readonly start: (core: Core) => Promise<JobRecord>;
}

/** Prints the numbered step list with each step's commands. */
export function printSteps(io: Io, steps: readonly PreviewStep[]): void {
  io.stdout('Steps');
  for (const [index, step] of steps.entries()) {
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

/** Prints a job's steps with their status, and its log. */
export function printJob(io: Io, job: JobRecord, log: readonly LogLine[]): void {
  io.stdout(`Job ${job.id}: ${job.kind} on pool ${job.poolId}, ${job.status}`);
  if (job.error !== null) {
    io.stdout(`${INDENT}${job.error}`);
  }
  for (const step of job.steps) {
    io.stdout(`${INDENT}${step.index + 1}. ${step.name}: ${step.status}`);
    for (const line of log.filter((entry) => entry.step === step.index)) {
      io.stdout(`${INDENT}${INDENT}${line.line}`);
    }
  }
}

/**
 * Starts or picks up a job and prints its progress until it finishes or the
 * user presses Ctrl-C. Returns the exit code.
 */
export async function followJob(io: Io, followed: FollowedJob): Promise<number> {
  const core = await io.core();
  let job: JobRecord | null = null;
  const early: RpcEvent[] = [];
  let finish: (outcome: Outcome) => void = () => undefined;
  const outcome = new Promise<Outcome>((resolve) => {
    finish = resolve;
  });
  const handle = (event: RpcEvent): void => {
    if (job === null) {
      // The job may report before its id is known; replay once it is.
      early.push(event);
      return;
    }
    if (eventJobId(event) !== job.id) {
      return;
    }
    const line = progressLine(event, job.steps.length);
    if (line !== null) {
      io.stdout(line);
    }
    if (event.event === 'job.status' && isFinished(event.data.status)) {
      finish(event.data.status);
    }
  };
  await core.subscribe(handle);
  job = await followed.start(core);
  for (const event of early.splice(0)) {
    handle(event);
  }
  if (isFinished(job.status)) {
    finish(job.status);
  }
  const stopInterrupt = io.onInterrupt(() => finish('detached'));
  const result = await outcome;
  stopInterrupt();
  return report(io, core, { subject: followed.subject, jobId: job.id, outcome: result });
}
