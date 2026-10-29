/**
 * Keeps the open pages current from `GET /api/v1/events` (decision 0010).
 * State changes refetch what shows the machine, job events refetch jobs.
 * The browser reconnects a dropped stream by itself.
 */

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { EventData, EventName, Result } from '@ohr/rpc/contract';

import { MACHINE_QUERIES, queryKeys } from './queries.ts';

const EVENTS_URL = '/api/v1/events';

/** Which queries each event makes stale. Log lines are added in place by appendLogLine. */
const STALE_AFTER: Record<EventName, readonly (readonly string[])[]> = {
  'state.changed': MACHINE_QUERIES,
  'job.status': [queryKeys.jobs],
  'job.step': [queryKeys.jobs],
  'job.log': [],
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
    return () => source.close();
  }, [client]);
  return status;
}
