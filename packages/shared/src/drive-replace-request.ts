/**
 * What a user asks for when replacing a drive of a pool, before core has
 * read the pool or planned anything (decision 0011). Core turns a request
 * into a drive-replace input, or into the reasons it refuses.
 */

import { z } from 'zod';

import { isValidPoolId } from './naming.ts';

export const driveReplaceRequestSchema = z.strictObject({
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
  /** Kernel device path of the drive to replace, or null for the one drive that is gone. */
  oldDrive: z.string().min(1).nullable(),
  /** Kernel device path of the new drive, such as /dev/sde. */
  newDrive: z.string().min(1),
  /** The user chose to erase the new drive if it holds something. */
  wipe: z.boolean(),
});

export type DriveReplaceRequest = z.infer<typeof driveReplaceRequestSchema>;
