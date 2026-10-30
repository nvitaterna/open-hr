/**
 * Parser for `lsblk --json --bytes --output <LSBLK_COLUMNS>`. Works with
 * util-linux 2.38.1, Debian 12's version, and newer. The PARTN column only
 * arrived in 2.39, so the partition number comes from the device name.
 */

import { z } from 'zod';

import { flagSchema, integerSchema, parseJsonText, textSchema, validate } from './parse-error.ts';

const SOURCE = 'lsblk output';
/** What follows the disk's name in a partition's: 2 in sda2, p2 in nvme0n1p2 or loop0p2. */
const PARTITION_SUFFIX = /^p?(?<number>[1-9]\d*)$/u;

const nodeSchema = z.object({
  name: z.string(),
  path: z.string(),
  pkname: textSchema,
  type: z.string(),
  size: integerSchema,
  model: textSchema,
  serial: textSchema,
  wwn: textSchema,
  tran: textSchema,
  rota: flagSchema,
  rm: flagSchema,
  ro: flagSchema,
  fstype: textSchema,
  uuid: textSchema,
  partuuid: textSchema,
  partlabel: textSchema,
  parttype: textSchema,
  partn: integerSchema.nullish(),
  start: integerSchema.nullish(),
  mountpoints: z.array(z.string().nullable()).nullish(),
  children: z.array(z.unknown()).optional(),
});

/** lsblk counts partition starts in 512-byte sectors whatever the drive's sector size. */
const SECTOR_BYTES = 512;

function startBytes(sectors: number | null | undefined): number | null {
  if (sectors === null || sectors === undefined) {
    return null;
  }
  return sectors * SECTOR_BYTES;
}

/**
 * The kernel names a partition after its disk plus its number, with a `p`
 * between them when the disk's name ends in a digit.
 */
function partitionNumber(node: z.infer<typeof nodeSchema>): number | null {
  if (node.partn !== null && node.partn !== undefined) {
    return node.partn;
  }
  if (node.type !== 'part' || node.pkname === null || !node.name.startsWith(node.pkname)) {
    return null;
  }
  const digits = PARTITION_SUFFIX.exec(node.name.slice(node.pkname.length))?.groups?.number;
  if (digits === undefined) {
    return null;
  }
  return Number(digits);
}

const rootSchema = z.object({ blockdevices: z.array(z.unknown()) });

function toBlockDevice(raw: unknown): BlockDevice {
  const node = validate(SOURCE, nodeSchema, raw);
  return {
    name: node.name,
    path: node.path,
    parentName: node.pkname,
    type: node.type,
    sizeBytes: node.size,
    model: node.model,
    serial: node.serial,
    wwn: node.wwn,
    transport: node.tran,
    rotational: node.rota,
    removable: node.rm,
    readOnly: node.ro,
    fsType: node.fstype,
    uuid: node.uuid,
    partUuid: node.partuuid,
    partLabel: node.partlabel,
    partType: node.parttype,
    partNumber: partitionNumber(node),
    startBytes: startBytes(node.start),
    mountpoints: (node.mountpoints ?? []).filter((point): point is string => point !== null),
    children: (node.children ?? []).map(toBlockDevice),
  };
}

/** Columns the parser expects, in the order passed to `lsblk --output`. */
export const LSBLK_COLUMNS = [
  'NAME',
  'PATH',
  'PKNAME',
  'TYPE',
  'SIZE',
  'MODEL',
  'SERIAL',
  'WWN',
  'TRAN',
  'ROTA',
  'RM',
  'RO',
  'FSTYPE',
  'UUID',
  'PARTUUID',
  'PARTLABEL',
  'PARTTYPE',
  'START',
  'MOUNTPOINTS',
] as const;

/** One block device. A device used by several parents, such as an md array, appears under each one. */
export interface BlockDevice {
  readonly name: string;
  readonly path: string;
  readonly parentName: string | null;
  /** disk, part, raid1, raid5, raid6, lvm, crypt, loop, rom, and so on. */
  readonly type: string;
  readonly sizeBytes: number;
  readonly model: string | null;
  readonly serial: string | null;
  readonly wwn: string | null;
  /** sata, nvme, usb, virtio, and so on. */
  readonly transport: string | null;
  readonly rotational: boolean;
  readonly removable: boolean;
  readonly readOnly: boolean;
  readonly fsType: string | null;
  readonly uuid: string | null;
  readonly partUuid: string | null;
  readonly partLabel: string | null;
  readonly partType: string | null;
  readonly partNumber: number | null;
  /** Where a partition starts on its drive. Null for anything that is not a partition. */
  readonly startBytes: number | null;
  readonly mountpoints: readonly string[];
  readonly children: readonly BlockDevice[];
}

export function parseLsblk(text: string): BlockDevice[] {
  const root = validate(SOURCE, rootSchema, parseJsonText(SOURCE, text));
  return root.blockdevices.map(toBlockDevice);
}

/** Every device in the tree, parents before children. */
export function flattenBlockDevices(devices: readonly BlockDevice[]): BlockDevice[] {
  return devices.flatMap((device) => [device, ...flattenBlockDevices(device.children)]);
}
