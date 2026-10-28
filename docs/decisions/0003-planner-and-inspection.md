# 0003. Layout planner rules and system inspection

- Status: Accepted
- Date: 2026-10-28

## Context

Milestone M1 builds the layout planner and the code that reads a machine's
storage state. Both needed rules the plan left open.

## Decision

### Planner

- **On-disk layout per drive.** GPT. Partition 1 is a 16 MiB label partition
  starting at 1 MiB. Tier _k_ lives in partition _k_ + 1 on every member
  drive. The last 64 MiB of each drive stay unused, so a replacement that is
  slightly smaller than the original still fits. Everything is aligned to
  1 MiB.
- **Tiers.** Tier boundaries are the sizes of the drives' usable areas.
  Boundaries closer than 1 GiB to the previous one are merged into it, so two
  "4 TB" drives from different vendors share a tier instead of creating a tiny
  extra array. That costs at most 1 GiB per merge on the larger drive.
- **Levels.** SHR-1: RAID1 for two members, RAID5 for three or more. SHR-2:
  three-way RAID1 for three members, RAID6 for four or more. A tier with
  fewer members is not built, and its space is reported as unused.
- **Minimum drive size** is the label area plus one 1 GiB tier plus the end
  reserve, about 1.1 GB.
- **Sizes need explicit units.** `4TB` is decimal like a drive label, `4TiB`
  is binary. A bare number or a bare `T` is rejected.
- **Displayed sizes round down**, so capacity is never overstated.

The planner in M1 only plans new pools. Planning changes to an existing pool,
such as adding a drive, arrives with expansion in M4.

### Inspection

- **Parsers live in `shared`**, are pure, and are tested against fixtures in
  `packages/shared/fixtures`. JSON outputs are validated with zod. Real output
  replaces synthesized fixtures as it is captured with
  `scripts/capture-fixtures.sh`.
- **One command runner** in `core` starts every external program. It never
  uses a shell, passes a fixed environment with a hard-coded system `PATH`
  and the C locale, and times commands out. It uses Node's `execFile`
  directly instead of the `execa` library the plan first named, to keep the
  root daemon's dependencies minimal.
- **SMART reads never wake a sleeping drive**, using `--nocheck=standby`.
- **Drive roles.** A drive is `system` if anything on it is mounted at `/`,
  `/boot`, `/boot/efi`, `/usr`, `/var`, `/home`, or used as swap. Otherwise
  `ohr` if any partition label starts with `ohr:`, `in-use` if it has
  partitions, a filesystem, or mounts, and `empty` if it has nothing. Open HR
  never touches a `system` drive.
- **Only an `lsblk` failure is fatal** when reading state. Anything else
  becomes a warning in the snapshot, because a partial view is still useful,
  for example when running without root.

## Consequences

The planner's output is fully determined by drive sizes, which makes it easy
to test exhaustively and to show in the UI before anything is written. The
1 GiB merge threshold and the 64 MiB reserve are part of the on-disk format
from now on; changing either later needs a new layout version.
