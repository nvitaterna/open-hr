/**
 * Runs a job's steps in order (plan section 5.4 and decision 0006). Each
 * step's precondition runs right before its action, every time, so a step
 * can tell when its work already happened and a job can resume after a
 * crash. A blocked precondition or any error stops the job at that step and
 * nothing is undone.
 */

import {
  firstIncompleteStep,
  isFinished,
  type JobKind,
  type JobRecord,
  type JobStatus,
  type StepStatus,
} from '@ohr/shared/jobs';

import type { CommandRunner } from '../command-runner.ts';
import type { SyncProgress } from '../executors/md-sync.ts';
import { JobMismatchError } from './job-mismatch-error.ts';
import type { JobStore } from './store.ts';

const NEEDS_QUOTES = /[^A-Za-z0-9_@%+=:,./-]/u;
const MACHINE_CHANGED = 'The machine changed since the preview. Plan the job again.';

interface RunState {
  readonly store: JobStore;
  readonly definition: JobDefinition;
  readonly jobId: string;
  readonly options: RunJobOptions;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function setJobStatus(state: RunState, status: JobStatus, error: string | null): JobRecord {
  const job = state.store.setJobStatus(state.jobId, status, error);
  state.options.listener?.({ kind: 'job', jobId: state.jobId, status, error });
  return job;
}

interface StepUpdate {
  readonly index: number;
  readonly name: string;
  readonly status: StepStatus;
  readonly error: string | null;
}

function setStepStatus(state: RunState, update: StepUpdate): void {
  state.store.setStepStatus(state.jobId, update.index, update.status, update.error);
  state.options.listener?.({ kind: 'step', jobId: state.jobId, ...update });
}

function log(state: RunState, step: number | null, line: string): void {
  state.store.appendLog(state.jobId, step, line);
  state.options.listener?.({ kind: 'log', jobId: state.jobId, step, line });
}

/** Loads the job and checks it was stored from this definition. */
function load(state: RunState): JobRecord {
  const job = state.store.getJob(state.jobId);
  if (job === null) {
    throw new JobMismatchError(`Job ${state.jobId} is not in the store`);
  }
  const storedNames = job.steps.map((step) => step.name).join('\n');
  const definedNames = state.definition.steps.map((step) => step.name).join('\n');
  if (job.kind !== state.definition.kind || storedNames !== definedNames) {
    throw new JobMismatchError(
      `Job ${state.jobId} does not match the ${state.definition.kind} definition`,
    );
  }
  return job;
}

/** Runs one step. Returns null on success or the reason it failed. */
async function runStep(state: RunState, index: number): Promise<string | null> {
  const step = state.definition.steps[index];
  if (step === undefined) {
    return `Step ${index} is missing from the job definition`;
  }
  const context: StepContext = {
    run: state.options.run,
    log: (line) => log(state, index, line),
    progress: (update) =>
      state.options.listener?.({ kind: 'progress', jobId: state.jobId, step: index, ...update }),
  };
  setStepStatus(state, { index, name: step.name, status: 'running', error: null });
  try {
    const precondition = await step.precondition(context);
    if (precondition.kind === 'blocked') {
      setStepStatus(state, {
        index,
        name: step.name,
        status: 'failed',
        error: precondition.reason,
      });
      return `${step.name}: ${precondition.reason}`;
    }
    if (precondition.kind === 'already-done') {
      log(state, index, `Already done: ${precondition.detail}`);
      setStepStatus(state, { index, name: step.name, status: 'skipped', error: null });
      return null;
    }
    await step.action(context);
    await step.postcondition(context);
    setStepStatus(state, { index, name: step.name, status: 'done', error: null });
    return null;
  } catch (error) {
    const message = errorMessage(error);
    setStepStatus(state, { index, name: step.name, status: 'failed', error: message });
    return `${step.name}: ${message}`;
  }
}

/** Runs the steps from `index` on, one after the other. Returns null or the first failure. */
async function runStepsFrom(state: RunState, index: number): Promise<string | null> {
  if (index >= state.definition.steps.length) {
    return null;
  }
  const failure = await runStep(state, index);
  if (failure !== null) {
    return failure;
  }
  return runStepsFrom(state, index + 1);
}

/** What a step reports before it runs. */
export type Precondition =
  | { readonly kind: 'ready' }
  /** The step's work is already there. It is skipped. */
  | { readonly kind: 'already-done'; readonly detail: string }
  /** The step must not run. The job fails here. */
  | { readonly kind: 'blocked'; readonly reason: string };

export interface StepContext {
  readonly run: CommandRunner;
  /** Adds a line to the job's log. */
  readonly log: (line: string) => void;
  /** Reports how far the step's work is (decision 0011). Sent to listeners, never stored. */
  readonly progress: (update: SyncProgress) => void;
}

export interface StepDefinition {
  /** Stable within the job, such as "partition /dev/sda". */
  readonly name: string;
  readonly description: string;
  /** The commands the step runs, for the preview. */
  readonly commands: readonly string[];
  readonly precondition: (context: StepContext) => Promise<Precondition>;
  readonly action: (context: StepContext) => Promise<void>;
  /** Throws if the action did not leave the system as expected. */
  readonly postcondition: (context: StepContext) => Promise<void>;
}

/** A job kind's steps for one input. Pure: built without touching the system. */
export interface JobDefinition {
  readonly kind: JobKind;
  readonly poolId: string;
  readonly input: unknown;
  readonly steps: readonly StepDefinition[];
}

export interface StepPreview {
  readonly name: string;
  readonly description: string;
  readonly commands: readonly string[];
}

export interface JobPreview {
  readonly kind: JobKind;
  readonly poolId: string;
  readonly steps: readonly StepPreview[];
}

export type JobEvent =
  | {
      readonly kind: 'job';
      readonly jobId: string;
      readonly status: JobStatus;
      readonly error: string | null;
    }
  | {
      readonly kind: 'step';
      readonly jobId: string;
      readonly index: number;
      readonly name: string;
      readonly status: StepStatus;
      readonly error: string | null;
    }
  | {
      readonly kind: 'log';
      readonly jobId: string;
      readonly step: number | null;
      readonly line: string;
    }
  | ({
      readonly kind: 'progress';
      readonly jobId: string;
      readonly step: number;
    } & SyncProgress);

export type JobListener = (event: JobEvent) => void;

export interface RunJobOptions {
  readonly run: CommandRunner;
  /** The state hash computed now. If it differs from the job's, the job fails before any step. */
  readonly stateHash?: string;
  readonly listener?: JobListener;
}

/** A command line for display: the arguments joined, quoted where a shell would need it. */
export function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((word) => {
      if (word !== '' && !NEEDS_QUOTES.test(word)) {
        return word;
      }
      return `'${word.replaceAll("'", String.raw`'\''`)}'`;
    })
    .join(' ');
}

/** The step list and commands, without touching the system. */
export function previewJob(definition: JobDefinition): JobPreview {
  return {
    kind: definition.kind,
    poolId: definition.poolId,
    steps: definition.steps.map((step) => ({
      name: step.name,
      description: step.description,
      commands: step.commands,
    })),
  };
}

/** Stores the job as pending. Throws JobConflictError if the pool has an unfinished job. */
export function submitJob(
  store: JobStore,
  definition: JobDefinition,
  stateHash: string,
): JobRecord {
  return store.createJob({
    kind: definition.kind,
    poolId: definition.poolId,
    input: definition.input,
    stateHash,
    steps: previewJob(definition).steps,
  });
}

/**
 * Runs a stored job from its first incomplete step and returns its final
 * record. A finished job is returned as it is. Throws JobMismatchError if
 * the definition is not the one the job was stored from.
 */
export async function runJob(
  store: JobStore,
  definition: JobDefinition,
  jobId: string,
  options: RunJobOptions,
): Promise<JobRecord> {
  const state: RunState = { store, definition, jobId, options };
  const job = load(state);
  if (isFinished(job.status)) {
    return job;
  }
  if (options.stateHash !== undefined && options.stateHash !== job.stateHash) {
    return setJobStatus(state, 'failed', MACHINE_CHANGED);
  }
  setJobStatus(state, 'running', null);
  const first = firstIncompleteStep(job.steps);
  let failure: string | null = null;
  if (first !== null) {
    failure = await runStepsFrom(state, first.index);
  }
  if (failure !== null) {
    return setJobStatus(state, 'failed', failure);
  }
  return setJobStatus(state, 'done', null);
}
