/** Parser for `findmnt --json --bytes --output <FINDMNT_COLUMNS>`. */

import { z } from 'zod';

import { integerSchema, parseJsonText, textSchema, validate } from './parse-error.ts';

const SOURCE = 'findmnt output';
const BRACKETED_SUFFIX = /\[.*\]$/u;

const nodeSchema = z.object({
  target: z.string(),
  source: z.string(),
  fstype: z.string(),
  options: textSchema,
  size: integerSchema.nullish(),
  used: integerSchema.nullish(),
  avail: integerSchema.nullish(),
  children: z.array(z.unknown()).optional(),
});

const rootSchema = z.object({ filesystems: z.array(z.unknown()) });

function toMounts(raw: unknown): Mount[] {
  const node = validate(SOURCE, nodeSchema, raw);
  const mount: Mount = {
    target: node.target,
    source: node.source,
    device: node.source.replace(BRACKETED_SUFFIX, ''),
    fsType: node.fstype,
    options: node.options?.split(',') ?? [],
    sizeBytes: node.size ?? null,
    usedBytes: node.used ?? null,
    availableBytes: node.avail ?? null,
  };
  return [mount, ...(node.children ?? []).flatMap(toMounts)];
}

export const FINDMNT_COLUMNS = [
  'TARGET',
  'SOURCE',
  'FSTYPE',
  'OPTIONS',
  'SIZE',
  'USED',
  'AVAIL',
] as const;

export interface Mount {
  readonly target: string;
  /** As findmnt prints it, for example "/dev/sda1[/@data]" for a btrfs subvolume. */
  readonly source: string;
  /** The source without any bracketed subvolume or bind path. */
  readonly device: string;
  readonly fsType: string;
  readonly options: readonly string[];
  readonly sizeBytes: number | null;
  readonly usedBytes: number | null;
  readonly availableBytes: number | null;
}

/** Every mount, flattened, in the order findmnt lists them. */
export function parseFindmnt(text: string): Mount[] {
  const root = validate(SOURCE, rootSchema, parseJsonText(SOURCE, text));
  return root.filesystems.flatMap(toMounts);
}
