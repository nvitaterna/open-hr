/** Parser for `blkid -o export`, which prints one block of KEY=value lines per device. */

import { parseKeyValueBlocks } from './key-value.ts';
import { ParseError } from './parse-error.ts';

export interface BlkidEntry {
  readonly device: string;
  /** Signature type, such as ext4, btrfs, linux_raid_member, LVM2_member, or crypto_LUKS. */
  readonly type: string | null;
  readonly uuid: string | null;
  readonly label: string | null;
  readonly partLabel: string | null;
  readonly partUuid: string | null;
}

export function parseBlkid(text: string): BlkidEntry[] {
  return parseKeyValueBlocks(text).map((entries) => {
    const device = entries.get('DEVNAME');
    if (device === undefined) {
      throw new ParseError('Could not parse blkid output: a block has no DEVNAME');
    }
    return {
      device,
      type: entries.get('TYPE') ?? null,
      uuid: entries.get('UUID') ?? null,
      label: entries.get('LABEL') ?? null,
      partLabel: entries.get('PARTLABEL') ?? null,
      partUuid: entries.get('PARTUUID') ?? null,
    };
  });
}
