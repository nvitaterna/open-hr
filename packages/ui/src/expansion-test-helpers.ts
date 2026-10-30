/**
 * Fixtures for the expansion wizard tests: pool tank with one drive gone,
 * the drives that could join it, and a preview for each wizard.
 */

import type { Result } from '@ohr/rpc/contract';
import type { JobRecord } from '@ohr/shared/jobs';
import type { DriveView, PoolView } from '@ohr/shared/pool-view';

import { AT, DRIVE, POOL, signedInRoutes } from './ui-test-helpers.tsx';

const GB = 1_000_000_000;
const MIB = 1_048_576;
/** Each drive's size, and the larger in-use drive's. */
const DRIVE_BYTES = 4_000_000_000;
const LARGE_BYTES = 2 * DRIVE_BYTES;
/** Tier 1's slice on each drive, and the mirror it makes. */
const SLICE_BYTES = 3_000_000_000;
const TIER_PARTITION = 2;
/** Tier 1 is a two-drive mirror; tank has lost one of them. */
const TIER_MEMBERS = 2;
const JOB_ID = '00000000-0000-4000-8000-000000000009';
const POOL_UUID = '00000000-0000-4000-8000-0000000000bb';
const DRIVE_UUID = '00000000-0000-4000-8000-0000000000cc';

function drive(name: string, role: DriveView['role'], sizeBytes: number): DriveView {
  return { ...DRIVE, path: `/dev/${name}`, name, role, poolId: null, sizeBytes, serial: name };
}

const JOB: JobRecord = {
  id: JOB_ID,
  kind: 'pool-expand',
  poolId: 'tank',
  status: 'running',
  input: {},
  stateHash: 'h3',
  createdAt: AT,
  startedAt: AT,
  finishedAt: null,
  error: null,
  steps: [],
};

type Layout = Result<'pools.previewExpand'>['input']['target'];

function planned(device: string): Layout['drives'][number] {
  return {
    id: device,
    sizeBytes: DRIVE_BYTES,
    unusedBytes: 0,
    partitions: [
      { number: 1, role: 'label', tier: null, startBytes: MIB, sizeBytes: MIB },
      {
        number: 2,
        role: 'tier',
        tier: 1,
        startBytes: TIER_PARTITION * MIB,
        sizeBytes: SLICE_BYTES,
      },
    ],
  };
}

const TARGET: Layout = {
  redundancy: 'shr1',
  drives: [planned('/dev/sda'), planned('/dev/sdb')],
  tiers: [
    {
      tier: 1,
      partitionNumber: TIER_PARTITION,
      level: 'raid1',
      members: ['/dev/sda', '/dev/sdb'],
      sliceBytes: SLICE_BYTES,
      arrayBytes: SLICE_BYTES,
      usableBytes: SLICE_BYTES,
    },
  ],
  rawBytes: LARGE_BYTES,
  usableBytes: SLICE_BYTES,
};

/** tank with two member drives and one gone from its only tier. */
const TANK: PoolView = {
  ...POOL,
  drives: [
    {
      path: '/dev/sda',
      model: 'A',
      serial: 'S1',
      sizeBytes: DRIVE_BYTES,
      driveUuid: null,
      label: 'ok',
      membership: 'member',
    },
    {
      path: '/dev/sde',
      model: 'E',
      serial: 'S5',
      sizeBytes: DRIVE_BYTES,
      driveUuid: null,
      label: 'ok',
      membership: 'removed',
    },
  ],
  tiers: [
    {
      tier: 1,
      arrayPath: '/dev/md/ohr_tank_t1',
      kernelName: 'md127',
      level: 'raid1',
      sizeBytes: SLICE_BYTES,
      expectedMembers: TIER_MEMBERS,
      health: 'degraded',
      sync: null,
      members: [{ drive: '/dev/sda', partition: '/dev/sda2', state: 'active' }],
    },
  ],
};

const TANK_DRIVES = [
  { ...drive('sda', 'ohr', DRIVE_BYTES), poolId: 'tank' },
  drive('sdb', 'empty', DRIVE_BYTES),
  drive('sdd', 'in-use', LARGE_BYTES),
];

const EXPAND_PREVIEW: Result<'pools.previewExpand'> = {
  input: {
    poolId: 'tank',
    poolUuid: POOL_UUID,
    redundancy: 'shr1',
    wipe: false,
    newDrives: [
      { path: '/dev/sdb', serial: null, wwn: null, sizeBytes: DRIVE_BYTES, driveUuid: DRIVE_UUID },
    ],
    target: TARGET,
    usableBytesBefore: 2 * GB,
    actions: [{ kind: 'partition-drive', drive: '/dev/sdb', partitions: [] }],
    growVolume: {
      name: 'media',
      filesystem: 'btrfs',
      mountPoint: '/mnt/ohr/media',
      size: { kind: 'all-free' },
    },
  },
  steps: [
    {
      name: 'grow tier 1',
      description: 'Add the new partition to the array.',
      commands: ['mdadm --grow /dev/md/ohr_tank_t1 --raid-devices=3'],
    },
  ],
  stateHash: 'h3',
};

const REPLACE_PREVIEW: Result<'drives.previewReplace'> = {
  input: {
    ...EXPAND_PREVIEW.input,
    growVolume: null,
    oldDrive: '/dev/sda',
    actions: [
      { kind: 'replace-member', tier: 1, oldDrive: '/dev/sda', newDrive: '/dev/sdb', mode: 'live' },
    ],
  },
  steps: [
    {
      name: 'copy tier 1',
      description: 'Copy onto the new drive.',
      commands: ['mdadm /dev/md/ohr_tank_t1 --replace /dev/sda2 --with /dev/sdb2'],
    },
  ],
  stateHash: 'h4',
};

const GROW_PREVIEW: Result<'volumes.previewGrow'> = {
  input: {
    poolId: 'tank',
    name: 'media',
    filesystem: 'btrfs',
    mountPoint: '/mnt/ohr/media',
    size: { kind: 'all-free' },
  },
  sizeBytes: LARGE_BYTES,
  steps: [
    {
      name: 'grow the volume',
      description: 'Extend the volume and its filesystem.',
      commands: ['lvextend --resizefs -l +100%FREE ohr-tank/media'],
    },
  ],
  stateHash: 'h5',
};

function tankJob(kind: JobRecord['kind']): JobRecord {
  return { ...JOB, kind, poolId: 'tank' };
}

function tankRoutes(extra = {}): ReturnType<typeof signedInRoutes> {
  return signedInRoutes({
    'GET /pools/tank': { body: { pool: TANK } },
    'GET /drives': { body: { drives: TANK_DRIVES } },
    ...extra,
  });
}

export { EXPAND_PREVIEW, GB, GROW_PREVIEW, JOB_ID, REPLACE_PREVIEW, tankJob, tankRoutes };
