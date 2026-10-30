/**
 * Every API read and change the UI makes, as TanStack Query hooks. Query
 * keys live here too, so live events (live-events.ts) can invalidate them.
 */

import {
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import type { EventData, Result } from '@ohr/rpc/contract';
import type { PoolCreateRequest } from '@ohr/shared/pool-create-request';
import type {
  DriveReplacePreviewRequest,
  DriveReplaceSubmission,
  LoginRequest,
  Me,
  PoolExpandPreviewRequest,
  PoolExpandSubmission,
  PoolSubmission,
  SetupRequest,
  SetupStatus,
  VolumeGrowPreviewRequest,
  VolumeGrowSubmission,
  VolumePreviewRequest,
  VolumeSubmission,
} from '@ohr/shared/web-api';

import { ApiRequestError } from './api-request-error.ts';
import { apiGet, apiPost } from './http.ts';

const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const ME_KEY = 'me';

/** After the session started or ended, everything is asked again. */
function sessionChanged(client: QueryClient, me: Me | null): Promise<void> {
  client.setQueryData([ME_KEY], me);
  return client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== ME_KEY });
}

function poolPath(poolId: string): string {
  return `/pools/${encodeURIComponent(poolId)}`;
}

function volumePath(poolId: string, name: string): string {
  return `${poolPath(poolId)}/volumes/${encodeURIComponent(name)}`;
}

/** A mutation that starts a job from a preview, then refreshes the job list. */
function useSubmitJob<S>(path: string): UseMutationResult<Result<'jobs.submit'>, Error, S> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (submission: S) => apiPost<Result<'jobs.submit'>>(path, submission),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
}

export const queryKeys = {
  setup: ['setup'],
  me: [ME_KEY],
  system: ['system'],
  drives: ['drives'],
  pools: ['pools'],
  jobs: ['jobs'],
  /** Per job, the last `job.progress` event. Kept apart from jobs so refetching a job keeps it. */
  progress: ['job-progress'],
} as const;

/** The queries that show the machine. A `state.changed` event makes them fetch again. */
export const MACHINE_QUERIES = [queryKeys.system, queryKeys.drives, queryKeys.pools] as const;

/** Whether setup is still needed. */
export function useSetupStatus(): UseQueryResult<SetupStatus> {
  return useQuery({ queryKey: queryKeys.setup, queryFn: () => apiGet<SetupStatus>('/setup') });
}

/** The signed-in user, or null when nobody is signed in. */
export function useMe(enabled: boolean): UseQueryResult<Me | null> {
  return useQuery({
    queryKey: queryKeys.me,
    enabled,
    queryFn: () =>
      apiGet<Me>('/auth/me').catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.status === UNAUTHORIZED) {
          return null;
        }
        throw error;
      }),
  });
}

export function useSystem(): UseQueryResult<Result<'system.state'>> {
  return useQuery({ queryKey: queryKeys.system, queryFn: () => apiGet('/system') });
}

export function useDrives(): UseQueryResult<Result<'drives.list'>> {
  return useQuery({ queryKey: queryKeys.drives, queryFn: () => apiGet('/drives') });
}

export function usePools(): UseQueryResult<Result<'pools.list'>> {
  return useQuery({ queryKey: queryKeys.pools, queryFn: () => apiGet('/pools') });
}

/** One pool. Its key starts with the pools key, so a state change refetches it too. */
export function usePool(id: string): UseQueryResult<Result<'pools.get'>> {
  return useQuery({
    queryKey: [...queryKeys.pools, id],
    queryFn: () => apiGet(`/pools/${encodeURIComponent(id)}`),
  });
}

/** One job with its log. Live log lines are added to it by live-events.ts. */
export function useJob(id: string): UseQueryResult<Result<'jobs.get'>> {
  return useQuery({
    queryKey: [...queryKeys.jobs, id],
    queryFn: () => apiGet(`/jobs/${encodeURIComponent(id)}`),
  });
}

export type JobProgress = EventData<'job.progress'>;

/**
 * The last progress a job's running step reported, or null. It only comes
 * from live events (live-events.ts); core does not store it, so there is
 * nothing to fetch, and asking again clears it until the next event.
 */
export function useJobProgress(id: string): JobProgress | null {
  return useQuery<JobProgress | null>({
    queryKey: [...queryKeys.progress, id],
    queryFn: () => null,
    initialData: null,
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
}

/** Runs a failed job again from its failed step. */
export function useRetryJob(): UseMutationResult<Result<'jobs.retry'>, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiPost<Result<'jobs.retry'>>(`/jobs/${encodeURIComponent(id)}/retry`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
}

/** Plans a pool. Refused with ApiRequestError 422 and core's reasons. */
export function usePreviewPool(): UseMutationResult<
  Result<'pools.previewCreate'>,
  Error,
  PoolCreateRequest
> {
  return useMutation({
    mutationFn: (request: PoolCreateRequest) =>
      apiPost<Result<'pools.previewCreate'>>('/pools/preview', request),
  });
}

/** Starts the pool-create job from a preview. */
export function useCreatePool(): UseMutationResult<Result<'jobs.submit'>, Error, PoolSubmission> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (submission: PoolSubmission) =>
      apiPost<Result<'jobs.submit'>>('/pools', submission),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
}

/** Plans a volume on `poolId`. */
export function usePreviewVolume(
  poolId: string,
): UseMutationResult<Result<'volumes.previewCreate'>, Error, VolumePreviewRequest> {
  return useMutation({
    mutationFn: (request: VolumePreviewRequest) =>
      apiPost<Result<'volumes.previewCreate'>>(
        `/pools/${encodeURIComponent(poolId)}/volumes/preview`,
        request,
      ),
  });
}

/** Starts the volume-create job from a preview. */
export function useCreateVolume(
  poolId: string,
): UseMutationResult<Result<'jobs.submit'>, Error, VolumeSubmission> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (submission: VolumeSubmission) =>
      apiPost<Result<'jobs.submit'>>(`/pools/${encodeURIComponent(poolId)}/volumes`, submission),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
}

/** Plans adding drives to `poolId`, or using the space its drives already have. */
export function usePreviewExpand(
  poolId: string,
): UseMutationResult<Result<'pools.previewExpand'>, Error, PoolExpandPreviewRequest> {
  return useMutation({
    mutationFn: (request: PoolExpandPreviewRequest) =>
      apiPost<Result<'pools.previewExpand'>>(`${poolPath(poolId)}/expand/preview`, request),
  });
}

/** Starts the pool-expand job from a preview. */
export function useExpandPool(
  poolId: string,
): UseMutationResult<Result<'jobs.submit'>, Error, PoolExpandSubmission> {
  return useSubmitJob(`${poolPath(poolId)}/expand`);
}

/** Plans replacing a drive of `poolId`. */
export function usePreviewReplace(
  poolId: string,
): UseMutationResult<Result<'drives.previewReplace'>, Error, DriveReplacePreviewRequest> {
  return useMutation({
    mutationFn: (request: DriveReplacePreviewRequest) =>
      apiPost<Result<'drives.previewReplace'>>(`${poolPath(poolId)}/replace/preview`, request),
  });
}

/** Starts the drive-replace job from a preview. */
export function useReplaceDrive(
  poolId: string,
): UseMutationResult<Result<'jobs.submit'>, Error, DriveReplaceSubmission> {
  return useSubmitJob(`${poolPath(poolId)}/replace`);
}

/** Plans growing volume `name` of `poolId`. */
export function usePreviewGrow(
  poolId: string,
  name: string,
): UseMutationResult<Result<'volumes.previewGrow'>, Error, VolumeGrowPreviewRequest> {
  return useMutation({
    mutationFn: (request: VolumeGrowPreviewRequest) =>
      apiPost<Result<'volumes.previewGrow'>>(`${volumePath(poolId, name)}/grow/preview`, request),
  });
}

/** Starts the volume-grow job from a preview. */
export function useGrowVolume(
  poolId: string,
  name: string,
): UseMutationResult<Result<'jobs.submit'>, Error, VolumeGrowSubmission> {
  return useSubmitJob(`${volumePath(poolId, name)}/grow`);
}

export function useJobs(): UseQueryResult<Result<'jobs.list'>> {
  return useQuery({ queryKey: queryKeys.jobs, queryFn: () => apiGet('/jobs') });
}

/** A fresh read of the machine with SMART data. Slow, so only on request; the result is not cached in core. */
export function useSmartRead(): UseMutationResult<Result<'system.state'>, Error, void> {
  return useMutation({ mutationFn: () => apiGet<Result<'system.state'>>('/system?smart=true') });
}

export function useSetup(): UseMutationResult<Me, Error, SetupRequest> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: SetupRequest) => apiPost<Me>('/setup', request),
    onSuccess: async (me) => {
      client.setQueryData(queryKeys.setup, { required: false });
      await sessionChanged(client, me);
    },
  });
}

export function useLogin(): UseMutationResult<Me, Error, LoginRequest> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: LoginRequest) => apiPost<Me>('/auth/login', request),
    onSuccess: (me) => sessionChanged(client, me),
  });
}

export function useLogout(): UseMutationResult<void, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<void>('/auth/logout'),
    onSuccess: () => {
      client.setQueryData(queryKeys.me, null);
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== ME_KEY });
    },
  });
}

/** True for an error that means the session is gone. */
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === UNAUTHORIZED;
}

/** True for an error that means the thing asked for does not exist. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === NOT_FOUND;
}

/** True when core refused a submission because the machine changed since the preview. */
export function isStateChanged(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'state-changed';
}
