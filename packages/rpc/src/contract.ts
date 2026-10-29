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
import { systemSnapshotSchema } from '@ohr/shared/system-snapshot';

const noParams = z.strictObject({});

/** The cached snapshot with when it was read and its state hash (decision 0006). */
const cachedStateSchema = z.strictObject({
  snapshot: systemSnapshotSchema,
  readAt: z.iso.datetime(),
  stateHash: z.string().min(1),
});

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
  'system.state': {
    params: noParams,
    result: cachedStateSchema,
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
