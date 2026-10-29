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

import type { Result } from '@ohr/rpc/contract';
import type { LoginRequest, Me, SetupRequest, SetupStatus } from '@ohr/shared/web-api';

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

export const queryKeys = {
  setup: ['setup'],
  me: [ME_KEY],
  system: ['system'],
  drives: ['drives'],
  pools: ['pools'],
  jobs: ['jobs'],
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

/** Runs a failed job again from its failed step. */
export function useRetryJob(): UseMutationResult<Result<'jobs.retry'>, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiPost<Result<'jobs.retry'>>(`/jobs/${encodeURIComponent(id)}/retry`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
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
