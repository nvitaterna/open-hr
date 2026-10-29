/**
 * What a user asks for when creating a volume, before core has checked the
 * pool (decision 0007). Core turns a request into a volume-create input, or
 * into the reasons it refuses.
 */

import { z } from 'zod';

import { isValidPoolId } from './naming.ts';
import { volumeSizeSchema } from './volume-create-input.ts';
import { isValidVolumeName } from './volume-name.ts';

export const volumeCreateRequestSchema = z.strictObject({
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
  name: z.string().refine(isValidVolumeName, 'not a valid volume name'),
  filesystem: z.enum(['btrfs', 'ext4']),
  /** A byte count is rounded down to whole LVM extents. */
  size: volumeSizeSchema,
  /** Absolute directory path. Without it the volume goes under /mnt/ohr. */
  mountPoint: z.string().min(1).optional(),
});

export type VolumeCreateRequest = z.infer<typeof volumeCreateRequestSchema>;
