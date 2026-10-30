/**
 * What a user asks for when growing a volume, before core has checked the
 * pool (decision 0011). Core turns a request into a volume-grow input, or
 * into the reasons it refuses.
 */

import { z } from 'zod';

import { isValidPoolId } from './naming.ts';
import { isValidVolumeName } from './volume-name.ts';

export const volumeGrowRequestSchema = z.strictObject({
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
  name: z.string().refine(isValidVolumeName, 'not a valid volume name'),
  size: z.discriminatedUnion('kind', [
    /** Everything the pool has free. */
    z.strictObject({ kind: z.literal('all-free') }),
    /** This much more, rounded down to whole LVM extents. */
    z.strictObject({ kind: z.literal('add-bytes'), bytes: z.number().int().positive() }),
  ]),
});

export type VolumeGrowRequest = z.infer<typeof volumeGrowRequestSchema>;
