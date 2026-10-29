/**
 * Runs jobs inside the daemon (decision 0007). A submitted job is stored and
 * then runs in the background, so the client that submitted it can
 * disconnect. Every engine event goes to `onEvent`, which the daemon turns
 * into RPC events. On start, jobs a previous daemon left unfinished are
 * resumed from their first incomplete step (decision 0006).
 */

import type { JobRecord } from '@ohr/shared/jobs';

import type { CommandRunner } from '../command-runner.ts';
import { type JobDefinition, type JobEvent, runJob, submitJob } from '../jobs/engine.ts';
import type { JobStore } from '../jobs/store.ts';

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export interface JobRunnerOptions {
  readonly store: JobStore;
  readonly run: CommandRunner;
  /** Rebuilds a stored job's steps. */
  readonly definitionFor: (job: JobRecord) => JobDefinition;
  readonly onEvent: (event: JobEvent) => void;
  readonly log: (line: string) => void;
}

export class JobRunner {
  readonly #options: JobRunnerOptions;
  readonly #running = new Map<string, Promise<void>>();

  constructor(options: JobRunnerOptions) {
    this.#options = options;
  }

  /** Ids of jobs running in this process right now. */
  get runningJobIds(): string[] {
    return [...this.#running.keys()];
  }

  /**
   * Stores the job and starts it. Throws JobConflictError if its pool already
   * has an unfinished job. The state hash was checked by the caller.
   */
  submit(definition: JobDefinition, stateHash: string): JobRecord {
    const job = submitJob(this.#options.store, definition, stateHash);
    this.#start(job.id, definition);
    return job;
  }

  /** Starts every pending or running job left by a previous daemon. Returns how many. */
  resumeUnfinished(): number {
    const unfinished = this.#options.store.unfinishedJobs();
    for (const job of unfinished) {
      this.#options.log(`Resuming job ${job.id} (${job.kind} on pool ${job.poolId}).`);
      try {
        this.#start(job.id, this.#options.definitionFor(job));
      } catch (error) {
        this.#options.log(`Job ${job.id} cannot be resumed: ${errorText(error)}`);
        this.#options.store.setJobStatus(job.id, 'failed', `Could not resume: ${errorText(error)}`);
      }
    }
    return unfinished.length;
  }

  /** Resolves once every job started so far has stopped. For tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  #start(jobId: string, definition: JobDefinition): void {
    // The hash was checked when the job was submitted; a resumed job has changed the machine itself.
    const running = runJob(this.#options.store, definition, jobId, {
      run: this.#options.run,
      listener: this.#options.onEvent,
    })
      .then((job) => {
        this.#options.log(`Job ${job.id} ${job.status}: ${job.error ?? 'no errors'}`);
      })
      .catch((error: unknown) => {
        this.#options.log(`Job ${jobId} stopped: ${errorText(error)}`);
      })
      .finally(() => {
        this.#running.delete(jobId);
      });
    this.#running.set(jobId, running);
  }
}
