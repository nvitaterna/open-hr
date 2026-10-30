/**
 * Jobs: structural changes run as a list of steps (plan section 5.4 and
 * decision 0006). These are the persisted shapes, shared so the CLI and UI
 * can show a job without knowing how it runs.
 */

import { z } from 'zod';

const finishedStatuses: ReadonlySet<string> = new Set(['done', 'failed']);

export const JOB_KINDS = [
  'pool-create',
  'volume-create',
  'pool-expand',
  'drive-replace',
  'volume-grow',
] as const;
export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export const STEP_STATUSES = ['pending', 'running', 'done', 'skipped', 'failed'] as const;

export const jobKindSchema = z.enum(JOB_KINDS);
export const jobStatusSchema = z.enum(JOB_STATUSES);
export const stepStatusSchema = z.enum(STEP_STATUSES);

export type JobKind = z.infer<typeof jobKindSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const stepRecordSchema = z.object({
  index: z.number().int().nonnegative(),
  /** Stable within the job, such as "partition /dev/sda". */
  name: z.string().min(1),
  description: z.string(),
  /** The commands the step runs, one line each, for the preview. */
  commands: z.array(z.string()),
  status: stepStatusSchema,
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});

export const jobRecordSchema = z.object({
  id: z.uuid(),
  kind: jobKindSchema,
  poolId: z.string().min(1),
  status: jobStatusSchema,
  /** Enough to rebuild the step list. Its shape depends on the kind. */
  input: z.unknown(),
  /** Hash of the system state the preview was made from (decision 0006). */
  stateHash: z.string().min(1),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
  steps: z.array(stepRecordSchema),
});

export const logLineSchema = z.object({
  /** Step index, or null for lines about the job as a whole. */
  step: z.number().int().nonnegative().nullable(),
  at: z.iso.datetime(),
  line: z.string(),
});

export type StepRecord = z.infer<typeof stepRecordSchema>;
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type LogLine = z.infer<typeof logLineSchema>;

/** True once a job can no longer change. */
export function isFinished(status: JobStatus): boolean {
  return finishedStatuses.has(status);
}

/** The first step that still has work to do, or null when every step is done or skipped. */
export function firstIncompleteStep(steps: readonly StepRecord[]): StepRecord | null {
  return steps.find((step) => step.status !== 'done' && step.status !== 'skipped') ?? null;
}
