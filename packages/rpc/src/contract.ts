/**
 * The RPC contract between ohr-core and its clients (decision 0007). Every
 * method has a schema for its params and its result, and every event a
 * schema for its data. Core rejects params that do not match before a
 * handler runs, and clients check results the same way. A method that is not
 * listed here does not exist.
 */

import { z } from 'zod';

import {
  jobRecordSchema,
  jobStatusSchema,
  logLineSchema,
  stepStatusSchema,
} from '@ohr/shared/jobs';
import { poolCreateInputSchema } from '@ohr/shared/pool-create-input';
import { poolCreateRequestSchema } from '@ohr/shared/pool-create-request';
import { poolExpandInputSchema } from '@ohr/shared/pool-expand-input';
import { poolExpandRequestSchema } from '@ohr/shared/pool-expand-request';
import { driveViewSchema, poolViewSchema } from '@ohr/shared/pool-view';
import { systemSnapshotSchema } from '@ohr/shared/system-snapshot';
import { volumeCreateInputSchema } from '@ohr/shared/volume-create-input';
import { volumeCreateRequestSchema } from '@ohr/shared/volume-create-request';

const noParams = z.strictObject({});
const stateHashSchema = z.string().min(1);

/** The cached snapshot with when it was read and its state hash (decision 0006). */
const cachedStateSchema = z.strictObject({
  snapshot: systemSnapshotSchema,
  readAt: z.iso.datetime(),
  stateHash: stateHashSchema,
});

/** One step of a previewed job, with the exact commands it will run (safety rule 4). */
const stepPreviewSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  commands: z.array(z.string()),
});

/** A job to start: the input a preview returned and the state hash it was made from. */
const jobSubmissionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pool-create'),
    input: poolCreateInputSchema,
    stateHash: stateHashSchema,
  }),
  z.strictObject({
    kind: z.literal('volume-create'),
    input: volumeCreateInputSchema,
    stateHash: stateHashSchema,
  }),
  z.strictObject({
    kind: z.literal('pool-expand'),
    input: poolExpandInputSchema,
    stateHash: stateHashSchema,
  }),
]);

/** What an RPC error says went wrong. The list is closed. */
export const RPC_ERROR_CODES = [
  /** The message was not JSON, not a request, or named an unknown method. */
  'invalid-request',
  /** The params did not match the method's schema. */
  'invalid-params',
  'not-found',
  /** Another job holds the pool. */
  'conflict',
  /** The state hash no longer matches the machine. Preview again. */
  'state-changed',
  /** A safety check refused the request. The reasons say why. */
  'rejected',
  'internal',
] as const;

export const rpcErrorCodeSchema = z.enum(RPC_ERROR_CODES);

export type RpcErrorCode = z.infer<typeof rpcErrorCodeSchema>;

export const methods = {
  /**
   * The cached snapshot. With `smart`, a fresh read that includes SMART data,
   * which is slower and not cached.
   */
  'system.state': {
    params: z.strictObject({ smart: z.boolean().optional() }),
    result: cachedStateSchema,
  },
  /** Every pool on the machine, derived from the cached snapshot. */
  'pools.list': {
    params: noParams,
    result: z.strictObject({ pools: z.array(poolViewSchema) }),
  },
  /** One pool, or `not-found`. */
  'pools.get': {
    params: z.strictObject({ id: z.string().min(1) }),
    result: z.strictObject({ pool: poolViewSchema }),
  },
  /** Every drive with its role and pool. */
  'drives.list': {
    params: noParams,
    result: z.strictObject({ drives: z.array(driveViewSchema) }),
  },
  'jobs.list': {
    params: noParams,
    result: z.strictObject({ jobs: z.array(jobRecordSchema) }),
  },
  'jobs.get': {
    params: z.strictObject({ id: z.uuid() }),
    result: z.strictObject({ job: jobRecordSchema, log: z.array(logLineSchema) }),
  },
  /**
   * Checks a new pool against the machine and plans it. Refused with
   * `rejected` and the reasons, or answered with the job input to submit,
   * its steps and commands, and the state hash they were made from.
   */
  'pools.previewCreate': {
    params: poolCreateRequestSchema,
    result: z.strictObject({
      input: poolCreateInputSchema,
      steps: z.array(stepPreviewSchema),
      stateHash: stateHashSchema,
    }),
  },
  /**
   * Checks adding drives to a pool, or using space its drives already
   * have, and plans it (decision 0011). Like pools.previewCreate, with the
   * capacity before and after in the input.
   */
  'pools.previewExpand': {
    params: poolExpandRequestSchema,
    result: z.strictObject({
      input: poolExpandInputSchema,
      steps: z.array(stepPreviewSchema),
      stateHash: stateHashSchema,
    }),
  },
  /** Like pools.previewCreate, for a volume. `sizeBytes` is what the volume will get. */
  'volumes.previewCreate': {
    params: volumeCreateRequestSchema,
    result: z.strictObject({
      input: volumeCreateInputSchema,
      sizeBytes: z.number().int().nonnegative(),
      steps: z.array(stepPreviewSchema),
      stateHash: stateHashSchema,
    }),
  },
  /**
   * Stores a previewed job and starts it in the background. Core checks the
   * input again against the machine as it is now: `state-changed` if the
   * hash differs, `rejected` if a check fails or the input is not what a
   * fresh preview builds, `conflict` if the pool or its drives are busy.
   */
  'jobs.submit': {
    params: jobSubmissionSchema,
    result: z.strictObject({ job: jobRecordSchema }),
  },
  /**
   * Runs a failed job again from its failed step. Steps that already did
   * their work are skipped by their preconditions. `conflict` if the pool has
   * an unfinished job, `rejected` if the job did not fail or a newer job for
   * the pool exists.
   */
  'jobs.retry': {
    params: z.strictObject({ id: z.uuid() }),
    result: z.strictObject({ job: jobRecordSchema }),
  },
  /**
   * Starts the stream of events on this connection. With a job id, only that
   * job's events are sent. Calling it again replaces the filter.
   */
  'events.subscribe': {
    params: z.strictObject({ jobId: z.uuid().optional() }),
    result: z.strictObject({}),
  },
} as const;

export const events = {
  /** The cached snapshot changed. Clients call system.state for the new one. */
  'state.changed': z.strictObject({ readAt: z.iso.datetime(), stateHash: z.string().min(1) }),
  'job.status': z.strictObject({
    jobId: z.uuid(),
    status: jobStatusSchema,
    error: z.string().nullable(),
  }),
  'job.step': z.strictObject({
    jobId: z.uuid(),
    index: z.number().int().nonnegative(),
    name: z.string(),
    status: stepStatusSchema,
    error: z.string().nullable(),
  }),
  'job.log': z.strictObject({
    jobId: z.uuid(),
    step: z.number().int().nonnegative().nullable(),
    line: z.string(),
  }),
} as const;

export type MethodName = keyof typeof methods;
export type EventName = keyof typeof events;
export type Params<M extends MethodName> = z.input<(typeof methods)[M]['params']>;
export type Result<M extends MethodName> = z.output<(typeof methods)[M]['result']>;
/** Params as a handler receives them: after the schema has checked and parsed them. */
export type ParsedParams<M extends MethodName> = z.output<(typeof methods)[M]['params']>;
export type EventData<E extends EventName> = z.output<(typeof events)[E]>;

/** Any event with its data, narrowed by name. */
export type RpcEvent = {
  [E in EventName]: { readonly event: E; readonly data: EventData<E> };
}[EventName];

export const requestSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.unknown(),
});

export const errorBodySchema = z.strictObject({
  code: rpcErrorCodeSchema,
  message: z.string(),
  /** For `rejected`: one line per reason. */
  reasons: z.array(z.string()).optional(),
});

/** A reply. The id is null only when the request was too broken to have one. */
export const responseSchema = z.union([
  z.strictObject({ id: z.number().int().nonnegative(), result: z.unknown() }),
  z.strictObject({ id: z.number().int().nonnegative().nullable(), error: errorBodySchema }),
]);

export const eventMessageSchema = z.strictObject({ event: z.string(), data: z.unknown() });

export type RpcRequest = z.infer<typeof requestSchema>;
export type RpcResponse = z.infer<typeof responseSchema>;
export type ErrorBody = z.infer<typeof errorBodySchema>;

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}

export function isEventName(name: string): name is EventName {
  return Object.hasOwn(events, name);
}
