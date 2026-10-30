# 0011. Expansion: planning changes to a pool, and the expand, replace, and grow jobs

- Status: Accepted
- Date: 2026-10-29

## Context

Milestone M4 adds the operations from plan sections 3.4 and 4.4: add a drive,
replace a drive that still works or one that has failed, build a new tier
from leftover space, convert a two-member RAID1 tier to RAID5, and grow a
volume and its filesystem. Decision 0003 left the planner able to plan only
new pools. Decision 0006 left progress inside a long step unmodelled. Both
gaps matter now, because a reshape can run for days.

Three facts were measured before writing this, on Debian 13 (kernel 6.12,
mdadm 4.4, LVM 2.03.31) with loop devices:

- `mdadm --grow --level=5` on a two-member RAID1 converts it in place, but
  leaves a 64 KiB chunk. mdadm refuses to change the level and the chunk in
  one command. A second `mdadm --grow --chunk=512` gives the 512 KiB chunk
  from decision 0004.
- That chunk change must wait until the array has grown to three members.
  On a two-member RAID5 that is being written to, `--grow --chunk=512`, or
  the `--grow --raid-devices=3` that follows it, deadlocks the kernel (md
  stuck in `mddev_suspend`, writers stuck in `md_handle_request`; only a
  hard reset recovers). It hung in eight of nine runs with a mounted ext4
  volume being written, including three with `--raid-devices=3
  --chunk=512` in one command. The same steps with no writes always passed,
  which is why the first measurement missed it. Converting, adding, growing
  to three members with the 64 KiB chunk, and only then setting the 512 KiB
  chunk (a second, full reshape) passed every run under writes. Measured on
  Debian 13, kernel 6.12.113, mdadm 4.4, PR 3.
- `mdadm --add` then `mdadm --grow --raid-devices=n+1` grows a RAID5 without
  `--backup-file`. mdadm keeps the critical section in the members' spare
  space and the data offset does not move, so the grown array is data
  members times the usable member size, the same rule as creation.
- `pvresize` keeps the physical volume's first extent where `pvcreate` put
  it. A converted or grown array keeps the 1 MiB start of the array it was
  created as, not the start a fresh array of its new shape would get.

## Decision

### The pool as it is

- A new pure function in `shared` reads the current layout of a pool from a
  system snapshot: for each tier its partition number, its start and size in
  the tier area, its level, and its members; for each drive its partitions
  and the space after its last one; and each array's physical volume start
  and size as `pvs` reports them. The pool stays whatever the machine says it
  is (plan section 5.4). Nothing about the layout is stored in the database.
- A pool whose tiers do not line up, such as one tier at different offsets on
  different drives, is reported as irregular. The expansion planner refuses
  to plan for it and says why. Open HR never builds one, so this only
  catches hand edits.

### Planning a change

- `planExpansion(current, change)` is pure, like `planPool`. A change is one
  of: add drives, use leftover space (no new drives), or replace one drive.
  It returns the target layout, the capacity before and after, the space that
  stays unused and why, and an ordered list of actions. Each job kind turns
  the actions into steps. Planner tests cover every case in this section, and
  property tests check that usable capacity never shrinks, partitions never
  overlap, and existing partitions are never moved or resized.
- **Existing tiers never move.** Their partitions keep their numbers, starts,
  and sizes. Expansion only adds members to existing tiers and adds tiers
  above the highest one.
- **A drive joins tiers from the bottom up**, as many as fit. It joins tier
  _k_ only if it joins every tier below _k_ too. A tier fits when its
  partition ends at least 1 MiB before the end of the drive (room for the
  backup GPT), not when it fits in the drive's capacity minus the 64 MiB
  reserve. That is the point of the reserve: a replacement a few megabytes
  smaller than the original still takes every tier the original had.
- A drive too small for tier 1 is refused.
- **New tiers** go above the current highest tier boundary. The space
  available on each drive, new or existing, is everything from that boundary
  to its capacity minus the reserve. Boundaries come from those capacities
  with the 1 GiB merge rule from decision 0003, and the levels from section
  3.3. A new tier needs at least two members under SHR-1 and three under
  SHR-2, like any tier.
- **Level changes.** Under SHR-1 a two-member RAID1 tier that gains members
  becomes RAID5: convert the level, add the members and grow, then set the
  512 KiB chunk once the array has three or more members (see the measured
  deadlock above). The chunk change is a second reshape of the whole tier,
  which the preview's time estimate must count. Under SHR-2 a three-copy
  RAID1 tier that would gain a fourth member needs a change to RAID6 that
  mdadm cannot make in place.
  The planner refuses that change in M4 and says so. SHR-2 is M5's work.
- Space on a new drive between the last tier it joins and its capacity is
  unused unless it forms part of a new tier. The preview shows how much, and
  that it comes back when a larger drive is added.
- **Capacity.** Tier sizes use the rules from decision 0004, except that a
  converted or grown tier's usable space starts at its physical volume's
  real first extent, read from `pvs`. The preview shows the planner's
  number. The job does not depend on it to the byte: it resizes the physical
  volume and extends the volume to what LVM reports.

### Jobs

Three new job kinds. Each is a pure step builder from its input, as in
decision 0006, with preconditions that read live state so a re-run skips
work already done.

- **`pool-expand`** adds drives, uses leftover space, or both. Steps, in
  order: partition and label each new drive; add each new tier's partition
  to existing drives that take part (`sgdisk --new`, then `partx --add`,
  because the kernel cannot re-read a table that is in use); for each
  existing tier that gains members, in tier order, convert its level if
  needed, `mdadm --add` the new partitions, `mdadm --grow --raid-devices`,
  and wait for the reshape, then on a converted tier `mdadm --grow
  --chunk=512` and wait again; `pvresize` the arrays that grew; create each
  new tier's array, `pvcreate`, `vgextend`; rewrite the pool's
  `mdadm.conf` file; and, if the input names a volume, grow it (below).
- **`drive-replace`** replaces one member drive with one new drive, which
  must take at least every tier the old one had. Two forms, chosen by the
  planner from live state for each tier on its own, since a drive can fail
  in one tier and still work in another:
  - _Old member still active in the tier:_ partition and label the new
    drive, then add the new partition as a spare and run
    `mdadm --replace <old> --with <new>`, wait until md has swapped them,
    and remove the old member, which md leaves marked faulty. The array
    keeps its redundancy throughout.
  - _Old member failed, or the drive missing:_ remove the failed member
    with `mdadm --remove` (every failed member when the drive is gone),
    `mdadm --add` the new partition, and wait for the rebuild.

  Members are read from `/proc/mdstat` and md sysfs: `mdadm --detail
  --export` reports a failed member under its old slot number and a
  replaced one as a spare.

  The job does not erase the old drive. Its partitions and label stay as
  they are, the pool page shows it as "no longer in the pool", and the user
  takes it out or reuses it with the create-pool wipe option. Nothing is
  erased that the user did not ask to erase. Space
  on the new drive beyond the old one's tiers is used by a following
  `pool-expand` with no new drives, which the UI offers when the replace
  finishes. Keeping the two apart keeps each job's preconditions simple.
- **`volume-grow`** extends one volume to all free space in its volume group
  or by a given size (`lvextend`), then grows the filesystem online
  (`btrfs filesystem resize max` on its mount point, or `resize2fs`). It
  runs on its own, or as the last steps of `pool-expand`. Encrypted volumes
  arrive in M6, and their grow step (`cryptsetup resize`) with them.
- **Preconditions** for `pool-expand` and `drive-replace`: no other job on
  the pool (already enforced), every array in the pool active, and no
  resync, reshape, or recovery running, except the one the step itself waits
  for. A reshape step also refuses to start on a degraded array (safety rule
  5). `drive-replace` of a failed drive is the one job allowed on a degraded
  pool, and only on the arrays that drive was in. New drives pass the same
  checks as in pool creation: not `system`, not mounted, no signatures unless
  the user chose to wipe.
- **No backup file.** Growth runs without `--backup-file`, as measured. If
  mdadm asks for one on some kernel, the step fails with mdadm's message and
  nothing else happens. The kernel matrix in M7 runs the expansion suite on
  Debian 12 and 13.
- **Waiting and resuming.** A wait step reads `/proc/mdstat` and the md sysfs
  files every few seconds until the array is idle. After a daemon restart,
  the step that issued `mdadm --grow` sees the new member count and is
  skipped, and the wait step attaches to the reshape the kernel kept running.
  The same holds after a reboot, because md records the reshape position in
  the superblocks and continues after assembly. An array assembled at boot
  can come up auto-read-only, and then the reshape waits for the first
  write, which never comes if no volume on the pool is mounted. The wait
  step therefore sets an auto-read-only array read-write
  (`mdadm --readwrite`) before it starts reading.

### Progress

- A running wait step publishes progress: the operation (`reshape`,
  `recovery`, or `resync`), the fraction done, and the kernel's estimate of
  time left. It goes out as a new `job.progress` RPC event, which web relays
  over SSE. Progress is not stored; after a restart the kernel is asked again.
  The job page shows a progress bar on the running step.

### Interfaces

- RPC methods `pools.previewExpand`, `drives.previewReplace`, and
  `volumes.previewGrow` return a preview and a state hash, and `jobs.submit`
  takes the new kinds, as for creation (decision 0007).
- REST routes under `/api/v1/pools/:id/` mirror them, with the same error
  mapping as M3.
- CLI: `ohr pool add <pool> <drive>...`, `ohr pool expand <pool>` for
  leftover space, `ohr drive replace <pool> <old> <new>`, and
  `ohr volume grow <pool> <volume> [size]`. Each shows the preview and asks
  for confirmation like `ohr pool create`.
- UI: an Add drives wizard and a Use free space action on the pool page, a
  Replace action on each member drive, and Grow on each volume. All follow
  the create wizards' preview and confirm pattern from decision 0010.

### Tests

- Unit tests for the layout reader and the planner, with property tests.
- Step builder tests with the fake runner, including resuming from every
  step.
- Integration tests on loop devices: add one and two drives to SHR-1 pools
  of two and three members (with and without a level change), add a larger
  drive that creates a new tier, use leftover space, replace a healthy drive,
  replace a failed one (set faulty with `mdadm --fail`) and a missing one
  (loop device detached), and grow btrfs and ext4 volumes. Each test checks
  that a file written before the job reads back after it.
- **Kill and resume:** for every expansion job, the integration suite stops
  the job after each step's action and before its status is written, then
  resumes it in a new engine and checks the result. It also kills the daemon
  with `SIGKILL` during a reshape, starts it again, and checks the job
  finishes.
- `scripts/reboot-check.sh` gains a reshape case, run by hand on the VM: start
  an add, reboot mid-reshape, check that the pool assembles and the job
  finishes.

## Consequences

- One planner answers "what if I add this drive" for the preview, the CLI,
  and the jobs, and it is testable without root.
- A grown pool's numbers can differ slightly from a pool created at that size,
  because of the first extent. Tests pin both.
- Reshapes on large drives take days. The job holds the pool's one job slot
  until it finishes, so nothing else structural can start on that pool
  meanwhile. That is deliberate (safety rule 6).
- An old drive left after a replace still has Open HR partitions. The pool
  view must tell it apart from a missing member by its absence from every
  array, and must never count it in capacity.
- SHR-2 expansion that needs RAID1 to RAID6 waits for M5.
