/**
 * The input a volume-grow job is built from (decision 0011): the volume, the
 * size it ends at, and where its filesystem is mounted, since both
 * filesystems grow online. A size in bytes is the size afterwards, not an
 * amount to add, so running the job again does not grow the volume twice.
 */

import { z } from 'zod';

import { isValidPoolId } from './naming.ts';
import { volumeSizeSchema } from './volume-create-input.ts';
import { isValidVolumeName } from './volume-name.ts';

export const volumeGrowTargetSchema = z.object({
  name: z.string().refine(isValidVolumeName, 'not a valid volume name'),
  filesystem: z.enum(['btrfs', 'ext4']),
  /** Absolute, normalized directory path where the volume is mounted. */
  mountPoint: z.string().min(1),
  /** All free space, or the volume's size afterwards in bytes. */
  size: volumeSizeSchema,
});

export const volumeGrowInputSchema = volumeGrowTargetSchema.extend({
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
});

export type VolumeGrowTarget = z.infer<typeof volumeGrowTargetSchema>;
export type VolumeGrowInput = z.infer<typeof volumeGrowInputSchema>;
