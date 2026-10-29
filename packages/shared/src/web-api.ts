/**
 * Request and response bodies of ohr-web's API (decision
 * 0008), shared by the server and the browser.
 */

import { z } from 'zod';

import { poolCreateInputSchema } from './pool-create-input.ts';
import { volumeCreateInputSchema } from './volume-create-input.ts';
import { volumeCreateRequestSchema } from './volume-create-request.ts';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const stateHashSchema = z.string().min(1);

/** Shortest password the setup page accepts. */
export const MIN_PASSWORD_LENGTH = 12;
/** Longest password, so hashing cannot be used to burn CPU. */
export const MAX_PASSWORD_LENGTH = 256;

export const usernameSchema = z
  .string()
  .regex(USERNAME_PATTERN, '1 to 32 lowercase letters, digits, dots, dashes, or underscores');

export const setupStatusSchema = z.strictObject({
  /** True until the admin account exists. */
  required: z.boolean(),
});

export const setupRequestSchema = z.strictObject({
  /** The token the installer printed. */
  token: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  username: usernameSchema,
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

export const loginRequestSchema = z.strictObject({
  username: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export const meSchema = z.strictObject({ username: usernameSchema });

/** Every error the API sends: a stable code and a sentence for people. */
export const apiErrorSchema = z.strictObject({
  error: z.string(),
  message: z.string(),
  /** When a safety check refused the request: one sentence per reason. */
  reasons: z.array(z.string()).optional(),
});

/** `POST /api/v1/pools`: the input a preview returned and the state hash it was made from. */
export const poolSubmissionSchema = z.strictObject({
  input: poolCreateInputSchema,
  stateHash: stateHashSchema,
});

/** `POST /api/v1/pools/:id/volumes/preview`: a volume request; the pool comes from the path. */
export const volumePreviewRequestSchema = volumeCreateRequestSchema.omit({ poolId: true });

/** `POST /api/v1/pools/:id/volumes`: like poolSubmissionSchema, for a volume. */
export const volumeSubmissionSchema = z.strictObject({
  input: volumeCreateInputSchema,
  stateHash: stateHashSchema,
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;
export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type Me = z.infer<typeof meSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type PoolSubmission = z.infer<typeof poolSubmissionSchema>;
export type VolumePreviewRequest = z.infer<typeof volumePreviewRequestSchema>;
export type VolumeSubmission = z.infer<typeof volumeSubmissionSchema>;
