/**
 * What a user asks for when creating a pool, before core has checked the
 * drives or planned the layout (decision 0007). Core turns a request into a
 * pool-create input, or into the reasons it refuses.
 */

import { z } from 'zod';

import { isValidPoolId } from './naming.ts';

export const poolCreateRequestSchema = z.strictObject({
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
  redundancy: z.enum(['shr1', 'shr2']),
  /** Kernel device paths of the drives to use, such as /dev/sda. */
  devices: z.array(z.string().min(1)).min(1),
  /** The user chose to erase drives that hold something. */
  wipe: z.boolean(),
});

export type PoolCreateRequest = z.infer<typeof poolCreateRequestSchema>;
