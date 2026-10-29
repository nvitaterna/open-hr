# 0004. Partition names, label partition, and md and LVM overhead

- Status: Accepted
- Date: 2026-10-28

## Context

Milestone M2 writes pools to real drives, so the on-disk format has to be
fixed before the first executor exists. Building the M1 test pool by hand on
the `ohr-dev` VM showed three gaps:

- `sgdisk -c` cuts a partition name at the first colon, even an escaped one,
  so the `ohr:<pool>:t<k>` names from decision 0003 could not be written with
  the tool the plan names for partitioning.
- The partition type codes and the contents of the label partition were never
  decided.
- The planner assumed an md array is exactly its members' size and that the
  whole array becomes usable LVM space. Both overstate capacity.

## Decision

### Partition names

- Tier partitions are named `ohr-<pool>-t<k>` and the label partition
  `ohr-<pool>-label`. This replaces the colon form in decision 0003.
- A pool id is 1 to 8 lowercase letters or digits and never contains a dash,
  so a name splits unambiguously.
- A drive's role is `ohr` if any of its partitions has a name of exactly that
  form (`/^ohr-[a-z0-9]{1,8}-(label|t[1-9]\d*)$/`), not just the `ohr-`
  prefix, so a foreign partition that happens to start with `ohr-` is not
  mistaken for one of ours.
- md arrays (`ohr_<pool>_t<k>`) and the volume group (`ohr-<pool>`) keep
  their names.
- `sgdisk` alone creates and names partitions. Tested by renaming all 22
  partitions of the VM pool with `sgdisk -c` while its arrays were running.

### Partition types

- Tier partitions use `FD00`, Linux RAID.
- The label partition uses `8300`, Linux filesystem. Nothing auto-mounts that
  type, and `blkid` finds no signature in it, so other tools leave it alone.

### Label partition contents

- The first bytes of the 16 MiB label partition hold one UTF-8 JSON object
  followed by a newline. The rest of the partition is zeros. The descriptor is
  at most 64 KiB.
- Fields: `format` (always `"open-hr-label"`), `layoutVersion` (1),
  `poolId`, `poolUuid`, `driveUuid`, `redundancy` (`shr1` or `shr2`), and
  `writtenAt` (ISO 8601 UTC). `poolUuid` tells apart two pools with the same
  short id, for example after drives move between machines.
- Writing zeros the whole partition first, then writes the descriptor and
  flushes. By hand:
  `dd if=/dev/zero of=/dev/sda1 bs=1M count=16 && dd if=label.json of=/dev/sda1 conv=fsync`.
  Reading by hand: `head -c 65536 /dev/sda1 | tr -d '\0'`.
- There is one copy per drive. A pool of _n_ drives has _n_ copies, and md
  and LVM metadata describe the pool too, so a second copy per drive is not
  worth the extra format rule.
- A reader rejects a descriptor with an unknown `format` or a
  `layoutVersion` newer than it understands, and never rewrites it.

### md array superblocks

- Arrays are created with metadata 1.2, an internal write-intent bitmap, and
  a 512 KiB chunk on RAID5 and RAID6. mdadm refuses a chunk size on RAID1, so
  none is given there.
- Arrays are created with `--homehost=any`, so the superblock name is
  `any:ohr_<pool>_t<k>` instead of `<hostname>:ohr_<pool>_t<k>`. mdadm then
  assembles the array as `/dev/md/ohr_<pool>_t<k>` on any machine, which the
  recovery promise needs when drives move.
- Creation passes `--run`. Without it mdadm asks on stdin whether to continue
  when a member carries an old signature, and the daemon has no stdin. The
  signature check that protects a user's data runs before the job starts.

### md and LVM overhead

Measured with mdadm 4.4 and LVM 2.03.31 on loop devices from 1.1 GiB to
16 TiB. The planner uses these rules, so its numbers match `vgs` to the byte.

- **mdadm data offset.** Each member loses 1 MiB plus the largest power of two
  that is at most 1/1024 of the member, capped at 128 MiB. Any member of
  128 GiB or more loses 129 MiB. What is left is rounded down to the 512 KiB
  chunk.
- **Array size.** Data members times the usable member size. Data members are
  the members minus one for RAID5, minus two for RAID6, and one for RAID1.
- **LVM first extent.** One full stripe in: data members times 512 KiB,
  rounded up to at least 1 MiB. RAID1 starts at 1 MiB.
- **LVM extents.** The rest is used in whole 4 MiB extents.

On drives of 1 TB or more this costs about 0.003% of raw space per tier, so
it rarely changes a displayed size. It matters for exact numbers: a job that
creates a volume of `100%FREE` must agree with what the planner promised.

## Consequences

- Any Linux system can read the names with `lsblk -o NAME,PARTLABEL` and the
  descriptor with `head`, which keeps the recovery promise from the plan.
- The format is now fixed for layout version 1. Changing a name, a type code,
  or a descriptor field that readers depend on needs a new layout version.
- The overhead rules are measured, not specified by mdadm or LVM. A later
  version could change them. The planner tests pin the numbers against real
  captures, so re-running the capture on a new Debian release shows any
  drift.
- When `sgdisk` adds a partition to a drive whose other partitions are in
  use, the kernel cannot re-read the table. Adding a tier in M4 will need
  `partx --add` to tell the kernel about the new partition.
