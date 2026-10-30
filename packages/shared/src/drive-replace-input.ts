/**
 * The input a drive-replace job is built from (decision 0011): the
 * pool-expand input with the drive being replaced, and exactly one new
 * drive. The planner's actions say, tier by tier, whether the new drive is
 * copied live or rebuilt.
 */

import { z } from 'zod';

import { poolCreateDriveSchema } from './pool-create-input.ts';
import { poolExpandInputSchema } from './pool-expand-input.ts';

export const driveReplaceInputSchema = poolExpandInputSchema.extend({
  /** The drive being replaced, or null when it is gone from the machine. */
  oldDrive: z.string().min(1).nullable(),
  newDrives: z.array(poolCreateDriveSchema).length(1),
});

export type DriveReplaceInput = z.infer<typeof driveReplaceInputSchema>;
