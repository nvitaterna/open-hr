/**
 * The input a pool-create job is built from (decision 0006). It holds
 * everything the step list needs, including the planned layout, so a job
 * can be rebuilt from the database and resumed.
 */

import { z } from 'zod';

import { isValidPoolId } from './naming.ts';
import type { Layout } from './planner.ts';

export const plannedPartitionSchema = z.object({
  number: z.number().int().positive(),
  role: z.enum(['label', 'tier']),
  tier: z.number().int().positive().nullable(),
  startBytes: z.number().int().nonnegative(),
  sizeBytes: z.number().int().positive(),
});

export const plannedDriveSchema = z.object({
  id: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  partitions: z.array(plannedPartitionSchema),
  unusedBytes: z.number().int().nonnegative(),
});

export const plannedTierSchema = z.object({
  tier: z.number().int().positive(),
  partitionNumber: z.number().int().positive(),
  level: z.enum(['raid1', 'raid5', 'raid6']),
  members: z.array(z.string().min(1)),
  sliceBytes: z.number().int().positive(),
  arrayBytes: z.number().int().positive(),
  usableBytes: z.number().int().nonnegative(),
});

/** A planner layout as stored with a job. Drive ids are device paths. */
export const layoutSchema: z.ZodType<Layout> = z.object({
  redundancy: z.enum(['shr1', 'shr2']),
  drives: z.array(plannedDriveSchema),
  tiers: z.array(plannedTierSchema),
  rawBytes: z.number().int().nonnegative(),
  usableBytes: z.number().int().nonnegative(),
});

export const poolCreateDriveSchema = z.object({
  /** Kernel device path, such as /dev/sda. The same as the drive's id in the layout. */
  path: z.string().min(1),
  serial: z.string().nullable(),
  wwn: z.string().nullable(),
  sizeBytes: z.number().int().positive(),
  /** Goes into the drive's label partition. */
  driveUuid: z.uuid(),
});

export const poolCreateInputSchema = z.object({
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
  poolUuid: z.uuid(),
  redundancy: z.enum(['shr1', 'shr2']),
  /** The user chose to erase drives that hold something. */
  wipe: z.boolean(),
  drives: z.array(poolCreateDriveSchema).min(1),
  layout: layoutSchema,
});

export type PoolCreateDrive = z.infer<typeof poolCreateDriveSchema>;
export type PoolCreateInput = z.infer<typeof poolCreateInputSchema>;
