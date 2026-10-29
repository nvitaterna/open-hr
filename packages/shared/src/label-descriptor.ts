/**
 * The JSON descriptor at the start of each drive's label partition. It makes
 * a drive self-describing even if md and LVM metadata is damaged. Decision
 * 0004 fixes the format: one JSON object and a newline, then zeros.
 */

import { z } from 'zod';

import { isValidPoolId } from './naming.ts';

const LABEL_FORMAT = 'open-hr-label';
const NUL = 0;

const descriptorSchema = z.strictObject({
  format: z.literal(LABEL_FORMAT),
  layoutVersion: z.number().int().positive(),
  poolId: z.string().refine(isValidPoolId, 'not a valid pool id'),
  poolUuid: z.uuid(),
  driveUuid: z.uuid(),
  redundancy: z.enum(['shr1', 'shr2']),
  writtenAt: z.iso.datetime(),
});

const versionSchema = z.object({ format: z.unknown(), layoutVersion: z.unknown() });

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function decodeText(bytes: Uint8Array): string {
  const head = bytes.subarray(0, MAX_LABEL_DESCRIPTOR_BYTES);
  const end = head.indexOf(NUL);
  let text = head;
  if (end !== -1) {
    text = head.subarray(0, end);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(text).trim();
}

/** Layout version this code writes and understands. */
export const LAYOUT_VERSION = 1;

/** Largest descriptor allowed. A reader never looks further into the partition. */
export const MAX_LABEL_DESCRIPTOR_BYTES = 65_536;

export type LabelDescriptor = z.infer<typeof descriptorSchema>;

/** The fields a caller chooses. `format` and `layoutVersion` are always this code's. */
export type LabelFields = Omit<LabelDescriptor, 'format' | 'layoutVersion'>;

export type LabelReadResult =
  | { readonly kind: 'ok'; readonly descriptor: LabelDescriptor }
  /** Only zeros: a label partition that was never written. */
  | { readonly kind: 'empty' }
  /** An Open HR label from a newer layout version. Leave it alone. */
  | { readonly kind: 'unsupported'; readonly layoutVersion: number }
  | { readonly kind: 'invalid'; readonly reason: string };

export class LabelDescriptorError extends Error {
  override readonly name = 'LabelDescriptorError';
}

/** Bytes to write at the start of the label partition. Throws LabelDescriptorError on bad fields. */
export function encodeLabelDescriptor(fields: LabelFields): Uint8Array {
  const result = descriptorSchema.safeParse({
    format: LABEL_FORMAT,
    layoutVersion: LAYOUT_VERSION,
    ...fields,
  });
  if (!result.success) {
    throw new LabelDescriptorError(`Invalid label descriptor: ${issues(result.error)}`);
  }
  return new TextEncoder().encode(`${JSON.stringify(result.data)}\n`);
}

/** Reads a descriptor from the first bytes of a label partition. Never throws. */
export function decodeLabelDescriptor(bytes: Uint8Array): LabelReadResult {
  let text: string;
  try {
    text = decodeText(bytes);
  } catch {
    return { kind: 'invalid', reason: 'not UTF-8 text' };
  }
  if (text === '') {
    return { kind: 'empty' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  const version = versionSchema.safeParse(data);
  if (!version.success || version.data.format !== LABEL_FORMAT) {
    return { kind: 'invalid', reason: 'not an Open HR label' };
  }
  const { layoutVersion } = version.data;
  if (typeof layoutVersion === 'number' && layoutVersion > LAYOUT_VERSION) {
    return { kind: 'unsupported', layoutVersion };
  }
  const result = descriptorSchema.safeParse(data);
  if (!result.success) {
    return { kind: 'invalid', reason: issues(result.error) };
  }
  return { kind: 'ok', descriptor: result.data };
}
