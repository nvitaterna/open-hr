/**
 * The input a pool-expand job is built from (decision 0011). It holds the
 * planner's target layout and its actions, so the job can be rebuilt from
 * the database and resumed without planning again.
 */

import { z } from 'zod';

import type { ExpansionAction } from './expansion-plan.ts';
import { isValidPoolId } from './naming.ts';
import {
  layoutSchema,
  plannedPartitionSchema,
  poolCreateDriveSchema,
} from './pool-create-input.ts';
import { volumeGrowTargetSchema } from './volume-grow-input.ts';

const levelSchema = z.enum(['raid1', 'raid5', 'raid6']);
const tierSchema = z.number().int().positive();

export const expansionActionSchema: z.ZodType<ExpansionAction> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('partition-drive'),
    drive: z.string().min(1),
    partitions: z.array(plannedPartitionSchema),
  }),
  z.object({
    kind: z.literal('add-partitions'),
    drive: z.string().min(1),
    partitions: z.array(plannedPartitionSchema),
  }),
  z.object({ kind: z.literal('convert-to-raid5'), tier: tierSchema }),
  z.object({
    kind: z.literal('grow-tier'),
    tier: tierSchema,
    level: levelSchema,
    add: z.array(z.string().min(1)),
    members: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('resize-physical-volume'), tier: tierSchema }),
  z.object({
    kind: z.literal('create-tier'),
    tier: tierSchema,
    level: levelSchema,
    members: z.array(z.string().min(1)),
  }),
  z.object({
    kind: z.literal('replace-member'),
    tier: tierSchema,
    oldDrive: z.string().min(1).nullable(),
    newDrive: z.string().min(1),
    mode: z.enum(['live', 'rebuild']),
  }),
]);

export const poolExpandInputSchema = z.object({
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
  /** From the pool's labels. New drives' labels carry it. */
  poolUuid: z.uuid(),
  redundancy: z.enum(['shr1', 'shr2']),
  /** The user chose to erase new drives that hold something. */
  wipe: z.boolean(),
  /** Drives that join the pool, each with the UUID its label gets. Empty to use leftover space. */
  newDrives: z.array(poolCreateDriveSchema),
  /** The pool after the job. */
  target: layoutSchema,
  usableBytesBefore: z.number().int().nonnegative(),
  /** What the planner decided, in order. The job's steps follow them. */
  actions: z.array(expansionActionSchema).min(1),
  /**
   * A volume to grow into all free space at the end, or null. Optional so
   * jobs stored before it existed still parse.
   */
  growVolume: volumeGrowTargetSchema.nullable().optional(),
});

export type PoolExpandInput = z.infer<typeof poolExpandInputSchema>;
