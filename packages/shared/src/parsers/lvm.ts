/**
 * Parsers for the LVM reporting commands, run as
 * `pvs|vgs|lvs --reportformat json --units b --nosuffix --options <fields>`.
 * LVM prints every value as a string.
 */

import { z } from 'zod';

import { integerSchema, parseJsonText, textSchema, validate } from './parse-error.ts';

function reportRows<T>(source: string, key: string, rowSchema: z.ZodType<T>, text: string): T[] {
  const schema = z.object({
    report: z.array(z.object({ [key]: z.array(rowSchema) })).min(1),
  });
  const parsed = validate(source, schema, parseJsonText(source, text));
  return parsed.report.flatMap((section) => section[key] ?? []);
}

const pvRowSchema = z.object({
  pv_name: z.string(),
  vg_name: textSchema,
  pv_uuid: z.string(),
  pv_size: integerSchema,
  pv_free: integerSchema,
});

const vgRowSchema = z.object({
  vg_name: z.string(),
  vg_uuid: z.string(),
  vg_size: integerSchema,
  vg_free: integerSchema,
  pv_count: integerSchema,
  lv_count: integerSchema,
});

const lvRowSchema = z.object({
  lv_name: z.string(),
  vg_name: z.string(),
  lv_uuid: z.string(),
  lv_size: integerSchema,
  lv_path: textSchema,
  lv_attr: z.string(),
  lv_layout: z.string(),
});

/** Arguments that make pvs, vgs, and lvs print the JSON these parsers read. Append field names first. */
export function lvmReportArgs(fields: readonly string[]): string[] {
  return ['--reportformat', 'json', '--units', 'b', '--nosuffix', '--options', fields.join(',')];
}

export const PV_FIELDS = ['pv_name', 'vg_name', 'pv_uuid', 'pv_size', 'pv_free'] as const;
export const VG_FIELDS = [
  'vg_name',
  'vg_uuid',
  'vg_size',
  'vg_free',
  'pv_count',
  'lv_count',
] as const;
export const LV_FIELDS = [
  'lv_name',
  'vg_name',
  'lv_uuid',
  'lv_size',
  'lv_path',
  'lv_attr',
  'lv_layout',
] as const;

export interface PhysicalVolume {
  readonly device: string;
  readonly volumeGroup: string | null;
  readonly uuid: string;
  readonly sizeBytes: number;
  readonly freeBytes: number;
}

export interface VolumeGroup {
  readonly name: string;
  readonly uuid: string;
  readonly sizeBytes: number;
  readonly freeBytes: number;
  readonly physicalVolumeCount: number;
  readonly logicalVolumeCount: number;
}

export interface LogicalVolume {
  readonly name: string;
  readonly volumeGroup: string;
  readonly uuid: string;
  readonly sizeBytes: number;
  readonly path: string | null;
  /** The ten-character lv_attr string, see lvs(8). */
  readonly attributes: string;
  /**
   * Layout, such as linear, striped, "raid,raid1", or cache. Read from lv_layout
   * because asking lvs for segtype makes it print one row per segment.
   */
  readonly layout: string;
}

export function parsePvs(text: string): PhysicalVolume[] {
  return reportRows('pvs output', 'pv', pvRowSchema, text).map((row) => ({
    device: row.pv_name,
    volumeGroup: row.vg_name,
    uuid: row.pv_uuid,
    sizeBytes: row.pv_size,
    freeBytes: row.pv_free,
  }));
}

export function parseVgs(text: string): VolumeGroup[] {
  return reportRows('vgs output', 'vg', vgRowSchema, text).map((row) => ({
    name: row.vg_name,
    uuid: row.vg_uuid,
    sizeBytes: row.vg_size,
    freeBytes: row.vg_free,
    physicalVolumeCount: row.pv_count,
    logicalVolumeCount: row.lv_count,
  }));
}

export function parseLvs(text: string): LogicalVolume[] {
  return reportRows('lvs output', 'lv', lvRowSchema, text).map((row) => ({
    name: row.lv_name,
    volumeGroup: row.vg_name,
    uuid: row.lv_uuid,
    sizeBytes: row.lv_size,
    path: row.lv_path,
    attributes: row.lv_attr,
    layout: row.lv_layout,
  }));
}
