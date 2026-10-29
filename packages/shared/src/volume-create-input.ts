/**
 * The input a volume-create job is built from (decision 0006): which pool,
 * the volume's name, filesystem, size, and mount point.
 */

import { z } from 'zod';

import { isValidPoolId } from './naming.ts';
import { isValidVolumeName } from './volume-name.ts';

export const volumeSizeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all-free') }),
  z.object({ kind: z.literal('bytes'), bytes: z.number().int().positive() }),
]);

export const volumeCreateInputSchema = z.object({
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
  name: z.string().refine(isValidVolumeName, 'not a valid volume name'),
  filesystem: z.enum(['btrfs', 'ext4']),
  size: volumeSizeSchema,
  /** Absolute, normalized directory path. */
  mountPoint: z.string().min(1),
});

export type VolumeCreateInput = z.infer<typeof volumeCreateInputSchema>;
