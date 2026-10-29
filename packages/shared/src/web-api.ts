/**
 * Request and response bodies of ohr-web's account endpoints (decision
 * 0008), shared by the server and the browser.
 */

import { z } from 'zod';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;

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
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;
export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type Me = z.infer<typeof meSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
