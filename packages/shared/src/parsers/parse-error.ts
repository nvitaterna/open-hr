/** Shared plumbing for the command-output parsers. */

import { type ZodType, z } from 'zod';

const MAX_REPORTED_ISSUES = 3;
const DIGITS = /^\d+$/u;

/** Raised when a command's output does not have the shape a parser expects. */
export class ParseError extends Error {
  override readonly name = 'ParseError';
}

/** A whole number that some tools print as a JSON number and others as a string. */
export const integerSchema = z
  .union([z.number().int(), z.string().regex(DIGITS)])
  .transform((value) => Number(value));

/** A flag that newer util-linux prints as a boolean and older versions as "0" or "1". */
export const flagSchema = z
  .union([z.boolean(), z.enum(['0', '1'])])
  .transform((value) => value === true || value === '1');

/** A text field that may be missing or null, with surrounding padding removed. Empty becomes null. */
export const textSchema = z
  .string()
  .nullish()
  .transform((value) => {
    const trimmed = value?.trim() ?? '';
    if (trimmed === '') {
      return null;
    }
    return trimmed;
  });

export function parseJsonText(source: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ParseError(`Could not parse ${source}: output is not valid JSON`, { cause: error });
  }
}

export function validate<T>(source: string, schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, MAX_REPORTED_ISSUES)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ParseError(`Could not parse ${source}: ${issues}`);
  }
  return result.data;
}
