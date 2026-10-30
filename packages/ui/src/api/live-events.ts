/**
 * Keeps the open pages current from `GET /api/v1/events` (decision 0010).
 * State changes refetch what shows the machine, job events refetch jobs,
 * and progress is kept in place until its step stops running.
 * The browser reconnects a dropped stream by itself.
 */

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { EventData, EventName, Result } from '@ohr/rpc/contract';

import { type JobProgress, MACHINE_QUERIES, queryKeys } from './queries.ts';

const EVENTS_URL = '/api/v1/events';

/** Which queries each event makes stale. Log lines and progress are set in place below. */
const STALE_AFTER: Record<EventName, readonly (readonly string[])[]> = {
  'state.changed': MACHINE_QUERIES,
  'job.status': [queryKeys.jobs],
  'job.step': [queryKeys.jobs],
  'job.log': [],
  'job.progress': [],
};

/** Adds a log line to the job's page, if it is open, without fetching the whole job again. */
function appendLogLine(client: QueryClient, message: MessageEvent<string>): void {
  const data = JSON.parse(message.data) as EventData<'job.log'>;
  client.setQueryData<Result<'jobs.get'>>([...queryKeys.jobs, data.jobId], (current) => {
    if (current === undefined) {
      return current;
    }
    const line = { step: data.step, at: new Date().toISOString(), line: data.line };
    return { ...current, log: [...current.log, line] };
  });
}

function setProgress(client: QueryClient, message: MessageEvent<string>): void {
  const data = JSON.parse(message.data) as JobProgress;
  client.setQueryData([...queryKeys.progress, data.jobId], data);
}

/** Drops a step's progress once it stops running, and a job's once it finishes. */
function clearProgress(client: QueryClient, jobId: string, step: number | null): void {
  client.setQueryData<JobProgress | null>([...queryKeys.progress, jobId], (current) => {
    if (current === undefined || (step !== null && current?.step !== step)) {
      return current;
    }
    return null;
  });
}

function stepChanged(client: QueryClient, message: MessageEvent<string>): void {
  const data = JSON.parse(message.data) as EventData<'job.step'>;
  if (data.status !== 'running') {
    clearProgress(client, data.jobId, data.index);
  }
}

function statusChanged(client: QueryClient, message: MessageEvent<string>): void {
  const data = JSON.parse(message.data) as EventData<'job.status'>;
  if (data.status !== 'running') {
    clearProgress(client, data.jobId, null);
  }
}

export type LiveStatus = 'connecting' | 'live' | 'offline';

/** Listens to the event stream while mounted. Returns whether it is connected. */
export function useLiveEvents(): LiveStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');
  useEffect(() => {
    const source = new EventSource(EVENTS_URL);
    let opens = 0;
    source.addEventListener('open', () => {
      setStatus('live');
      opens += 1;
      if (opens > 1) {
        // Events may have been missed while the stream was down.
        client.invalidateQueries().catch(() => undefined);
      }
    });
    source.addEventListener('error', () => {
      if (source.readyState === EventSource.CLOSED) {
        setStatus('offline');
      } else {
        setStatus('connecting');
      }
    });
    for (const [event, keys] of Object.entries(STALE_AFTER)) {
      source.addEventListener(event, () => {
        for (const queryKey of keys) {
          client.invalidateQueries({ queryKey }).catch(() => undefined);
        }
      });
    }
    source.addEventListener('job.log', (message) => appendLogLine(client, message));
    source.addEventListener('job.progress', (message) => setProgress(client, message));
    source.addEventListener('job.step', (message) => stepChanged(client, message));
    source.addEventListener('job.status', (message) => statusChanged(client, message));
    return () => source.close();
  }, [client]);
  return status;
}
