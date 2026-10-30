/**
 * What a user asks for when growing a pool, before core has read the pool
 * or planned anything (decision 0011). Core turns a request into a
 * pool-expand input, or into the reasons it refuses.
 */

import { z } from 'zod';

import { isValidPoolId } from './naming.ts';
import { isValidVolumeName } from './volume-name.ts';

export const poolExpandRequestSchema = z.strictObject({
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
  /**
   * Kernel device paths of drives to add, such as /dev/sdd. Empty to only
   * use space the pool's drives already have.
   */
  devices: z.array(z.string().min(1)),
  /** The user chose to erase new drives that hold something. */
  wipe: z.boolean(),
  /** A mounted volume to grow into all the new space once the pool has grown. */
  growVolume: z.string().refine(isValidVolumeName, 'not a valid volume name').optional(),
});

export type PoolExpandRequest = z.infer<typeof poolExpandRequestSchema>;
