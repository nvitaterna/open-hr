/**
 * A fake ohr-core for web tests: fixtures, and handlers that answer from
 * them and record what they were asked.
 */

import { RpcError } from '@ohr/rpc/rpc-error';
import type { Handlers } from '@ohr/rpc/server';
import type { JobRecord } from '@ohr/shared/jobs';
import type { PoolExpandInput } from '@ohr/shared/pool-expand-input';
import type { DriveView, PoolView } from '@ohr/shared/pool-view';
import type { VolumeCreateInput } from '@ohr/shared/volume-create-input';
import type { VolumeGrowInput } from '@ohr/shared/volume-grow-input';

const AT = '2026-10-29T12:00:00.000Z';

const EMPTY_SNAPSHOT = {
  drives: [],
  mdArrays: [],
  physicalVolumes: [],
  volumeGroups: [],
  logicalVolumes: [],
  mounts: [],
  labels: [],
  warnings: [],
};

const STEPS = [{ name: 'Grow', description: 'Grow it.', commands: ['pvresize'] }];

export const GIB = 1_073_741_824;
export const JOB_ID = '00000000-0000-4000-8000-000000000001';
export const POOL_UUID = '00000000-0000-4000-8000-0000000000aa';

export const JOB: JobRecord = {
  id: JOB_ID,
  kind: 'volume-create',
  poolId: 'p1',
  status: 'running',
  input: {},
  stateHash: 'hash-1',
  createdAt: AT,
  startedAt: AT,
  finishedAt: null,
  error: null,
  steps: [],
};

export const DRIVE: DriveView = {
  path: '/dev/sda',
  name: 'sda',
  model: 'Disk',
  serial: 'S1',
  wwn: null,
  sizeBytes: GIB,
  transport: 'sata',
  rotational: true,
  role: 'ohr',
  poolId: 'p1',
  temperatureCelsius: null,
  smartPassed: null,
};

export const POOL: PoolView = {
  id: 'p1',
  uuid: POOL_UUID,
  redundancy: 'shr1',
  health: 'healthy',
  sizeBytes: GIB,
  freeBytes: 0,
  drives: [],
  tiers: [],
  volumes: [
    {
      name: 'data',
      path: '/dev/ohr-p1/data',
      sizeBytes: GIB,
      filesystem: 'btrfs',
      mountPoint: '/mnt/ohr/data',
      usedBytes: 0,
      availableBytes: GIB,
    },
  ],
  warnings: [],
};

export const VOLUME_INPUT: VolumeCreateInput = {
  poolId: 'p1',
  name: 'media',
  filesystem: 'ext4',
  size: { kind: 'all-free' },
  mountPoint: '/mnt/ohr/media',
};

export const EXPAND_INPUT: PoolExpandInput = {
  poolId: 'p1',
  poolUuid: POOL_UUID,
  redundancy: 'shr1',
  wipe: false,
  newDrives: [],
  target: { redundancy: 'shr1', drives: [], tiers: [], rawBytes: 2 * GIB, usableBytes: GIB },
  usableBytesBefore: GIB,
  actions: [{ kind: 'resize-physical-volume', tier: 1 }],
  growVolume: null,
};

export const GROW_INPUT: VolumeGrowInput = {
  poolId: 'p1',
  name: 'data',
  filesystem: 'btrfs',
  mountPoint: '/mnt/ohr/data',
  size: { kind: 'all-free' },
};

export interface Received {
  readonly method: string;
  readonly params: unknown;
}

/** Core handlers that answer from the fixtures and push each call onto `received`. */
export function fakeHandlers(received: Received[]): Handlers {
  const record = <T>(method: string, params: unknown, result: T): Promise<T> => {
    received.push({ method, params });
    return Promise.resolve(result);
  };
  return {
    'system.state': (params) =>
      record('system.state', params, { snapshot: EMPTY_SNAPSHOT, readAt: AT, stateHash: 'hash-1' }),
    'pools.list': (params) => record('pools.list', params, { pools: [POOL] }),
    'pools.get': ({ id }) => {
      if (id === POOL.id) {
        return record('pools.get', { id }, { pool: POOL });
      }
      return Promise.reject(new RpcError('not-found', `There is no pool ${id}.`));
    },
    'drives.list': (params) => record('drives.list', params, { drives: [DRIVE] }),
    'jobs.list': (params) => record('jobs.list', params, { jobs: [JOB] }),
    'jobs.get': ({ id }) => record('jobs.get', { id }, { job: { ...JOB, id }, log: [] }),
    'pools.previewCreate': () =>
      Promise.reject(
        new RpcError('rejected', 'The pool cannot be created.', [
          '/dev/sdb holds a filesystem. Choose wipe to erase it.',
        ]),
      ),
    'volumes.previewGrow': (params) =>
      record('volumes.previewGrow', params, {
        input: GROW_INPUT,
        sizeBytes: 2 * GIB,
        steps: STEPS,
        stateHash: 'hash-1',
      }),
    'drives.previewReplace': () =>
      Promise.reject(
        new RpcError('rejected', 'The drive cannot be replaced.', [
          '/dev/sdb is smaller than /dev/sda.',
        ]),
      ),
    'pools.previewExpand': (params) =>
      record('pools.previewExpand', params, {
        input: EXPAND_INPUT,
        steps: STEPS,
        stateHash: 'hash-1',
      }),
    'volumes.previewCreate': (params) =>
      record('volumes.previewCreate', params, {
        input: VOLUME_INPUT,
        sizeBytes: GIB,
        steps: [{ name: 'Create the volume', description: 'lvcreate', commands: ['lvcreate'] }],
        stateHash: 'hash-1',
      }),
    'jobs.submit': (params) => {
      if (params.stateHash !== 'hash-1') {
        return Promise.reject(new RpcError('state-changed', 'The machine changed. Preview again.'));
      }
      return record('jobs.submit', params, { job: JOB });
    },
    'jobs.retry': () => Promise.reject(new RpcError('conflict', 'Pool p1 has an unfinished job.')),
  };
}
