/**
 * How much of a tier's partitions ends up usable once mdadm and LVM have
 * taken their share. Measured with mdadm 4.4 and LVM 2.03.31 on Debian 13,
 * so the planner never promises more than the pool will have.
 */

import { LVM_EXTENT_BYTES, MD_CHUNK_BYTES } from './constants.ts';
import { alignDown } from './sizes.ts';

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const MD_MAX_HEADROOM_MIB = 128;
const MD_MAX_HEADROOM_BYTES = MD_MAX_HEADROOM_MIB * BYTES_PER_MIB;
const MD_HEADROOM_DIVISOR = 1024;
const RAID5_PARITY = 1;
const RAID6_PARITY = 2;

/**
 * Space mdadm keeps at the start of each member: 1 MiB for the superblock and
 * bitmap, plus headroom of the largest power of two up to 128 MiB that is at
 * most 1/1024 of the member.
 */
function mdDataOffset(memberBytes: number): number {
  let headroom = MD_MAX_HEADROOM_BYTES;
  while (headroom * MD_HEADROOM_DIVISOR > memberBytes && headroom > BYTES_PER_MIB) {
    headroom /= 2;
  }
  return BYTES_PER_MIB + headroom;
}

/** LVM aligns a physical volume's data to the array's full stripe. RAID1 has none. */
function stripeBytes(level: RaidLevel, members: number): number {
  if (level === 'raid1') {
    return BYTES_PER_MIB;
  }
  return dataMembers(level, members) * MD_CHUNK_BYTES;
}

export type RaidLevel = 'raid1' | 'raid5' | 'raid6';

/** Members whose space holds data rather than parity or mirror copies. */
export function dataMembers(level: RaidLevel, members: number): number {
  switch (level) {
    case 'raid1':
      return 1;
    case 'raid5':
      return members - RAID5_PARITY;
    case 'raid6':
      return members - RAID6_PARITY;
    default:
      throw new Error(`Unhandled RAID level: ${String(level satisfies never)}`);
  }
}

/** Size of an md array built from `members` partitions of `sliceBytes` each. */
export function arrayBytesFor(level: RaidLevel, members: number, sliceBytes: number): number {
  const memberData = alignDown(sliceBytes - mdDataOffset(sliceBytes), MD_CHUNK_BYTES);
  return dataMembers(level, members) * memberData;
}

/**
 * Space an array adds to the volume group. LVM starts the first extent at
 * 1 MiB, or at one full stripe when the stripe is wider, and allocates whole
 * extents after that.
 */
export function volumeGroupBytesFor(level: RaidLevel, members: number, arrayBytes: number): number {
  const stripe = stripeBytes(level, members);
  const firstExtent = Math.ceil(BYTES_PER_MIB / stripe) * stripe;
  return alignDown(arrayBytes - firstExtent, LVM_EXTENT_BYTES);
}
