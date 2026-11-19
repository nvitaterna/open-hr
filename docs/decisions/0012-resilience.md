# 0012. Resilience: health monitor, hot spares, scrubs, SMART, webhook alerts, and SHR-2 expansion

- Status: Accepted
- Date: 2026-11-19

## Context

Milestone M5 makes a pool look after itself: plan sections 4.5 (hot spares),
4.6 (scrubbing and health), and the monitor, alerts, and scheduler from
section 5.4. It also finishes SHR-2. Pools are created with SHR-2 since M2,
but decision 0011 left the planner refusing the one SHR-2 change that needs a
level change, a three-copy RAID1 tier that gains a fourth member. The
milestone is done when pulling a drive from the VM produces an alert, a
rebuild onto the spare, and a second alert on completion, with no user
action.

Decision 0006 left progress inside a long step to the monitor, and decision
0007 gave core one system snapshot, refreshed after each job step, on udev
block events, and on a timer. Nothing in core watches md between those
refreshes, and nothing turns a change of state into an event.

These facts were measured before writing this, on Debian 13 (kernel
6.12.113, mdadm 4.4, smartmontools 7.4) with loop and device-mapper devices:

- **What tells us a member failed.** With a RAID5 of three members and one
  spare, a member was switched to the `error` target and written to. The
  kernel marked it faulty and started recovery onto the spare within 10 ms,
  with no help from userspace. An `mdadm --monitor` started at the same time
  reported `Fail` and `RebuildStarted` at once, because the kernel wakes
  pollers of `/proc/mdstat` on a failure. It did not report the rebuild
  finishing two seconds later: the kernel does not wake pollers then, so
  mdadm only notices on its next `--delay` poll. udev saw one `change` event
  on the md device at the failure and none when the rebuild finished.
- **Debian already runs a monitor.** `mdmonitor.service` runs
  `mdadm --monitor --scan` and mails root or logs to syslog. A second
  `--scan` monitor refuses to start ("Only one autorebuild process allowed
  in scan mode") unless it is given `--no-sharing`.
- **A pulled drive.** Debian's `64-md-raid-assembly.rules` runs
  `mdadm -If <device>` when a block device is removed, so md marks the
  member failed and removes it when the drive disappears, not on the next
  I/O to it.
- **Debian already scrubs.** Debian 13's mdadm enables
  `mdcheck_start.timer` (first Sunday of the month, 01:00, with up to 24
  hours of random delay) and `mdcheck_continue.timer`, which check every md
  array on the machine in six-hour slices. Debian 12's mdadm does the same
  from cron with `checkarray` when `AUTOCHECK=true` in `/etc/default/mdadm`,
  the default (from the package, not measured here). Neither can leave out
  some arrays. smartmontools enables `smartd`, which mails root.
- **RAID1 with three copies to RAID6.** md cannot convert it directly:
  `mdadm --grow --level=5` answers "Can only convert a 2-device array to
  RAID5", and the kernel refuses `--level=6 --raid-devices=4` on a
  two-member RAID5 (`Invalid argument`, three runs of three). The path that
  works, under writes to a mounted ext4 volume, with the data and `fsck`
  clean afterwards, is: fail and remove one copy, `--grow --raid-devices=2`,
  `--grow --level=5` (64 KiB chunk), zero the removed member's superblock and
  `--add` it with the new partition, `--grow --raid-devices=3` (a reshape),
  `--grow --level=6 --raid-devices=4` (md converts to the `-6` layout, builds
  Q, and reshapes to the normal layout on its own; `degraded` reads 1 until
  it finishes), then `--grow --chunk=512` (a reshape). The tier survives only
  one failure from the first step until the RAID6 reshape finishes.
- **RAID6 grows without a backup file.** `--add` then
  `--grow --raid-devices=5` on a four-member RAID6 printed "Need to backup
  3072K of critical section" and went ahead without `--backup-file`, as
  RAID5 did in decision 0011.
- **A grow takes whichever spare md picks.** With a hot spare added before
  the new member, `--grow --raid-devices=n+1` used the new member and left
  the hot spare a spare. That is one run, and mdadm documents no order.

## Decision

### How the monitor learns of changes

- **Core watches md itself and does not run `mdadm --monitor`.** A second
  monitor fights Debian's, it misses the end of a rebuild unless it polls
  anyway, and its output would still have to be turned into Open HR's own
  states. Debian's `mdmonitor` and `smartd` keep running as the
  distribution set them up. Open HR never edits their configuration.
- **Three wake-ups, one source of truth.** Core reads `/proc/mdstat` every 5
  seconds; it is one small file. When its text changes other than in the
  progress figures, or on a udev block event (decision 0007), or on the
  existing timer, core refreshes the system snapshot. Changes in progress
  figures alone are published as progress, without a refresh. A failure is
  therefore seen within 5 seconds, usually at once through udev, and the end
  of a rebuild within 5 seconds.
- **The snapshot grows the md fields health needs:** for each array
  `sync_action`, `degraded`, `mismatch_cnt`, and `sync_completed` from sysfs,
  and for each member its state and its `errors` counter (read errors md
  corrected by rewriting). SMART data is not read on these refreshes; it has
  its own poll (below).
- **Health is a pure function of the snapshot.** `deriveHealth(snapshot,
  context)` in `shared` returns a health report for every drive, tier, pool,
  and volume. The context carries what the snapshot cannot: the latest SMART
  readings, the acknowledged baselines, volume fill, and the running job on
  each pool. `diffHealth(before, after)` returns the events between two
  reports. Both are unit-tested from fixture snapshots, like the planner.
- **Events survive restarts.** Core stores the last health report in the
  database. On start it diffs the first new report against the stored one,
  so a drive that failed while core was stopped still raises its event.
- **The monitor is not a job.** It only observes. The kernel promotes spares
  and runs rebuilds on its own, so there is nothing for the job engine to
  run, and a rebuild never holds the pool's job slot. The preconditions from
  decision 0011 already refuse structural jobs while a recovery runs.
- **Jobs and the monitor.** A job's own changes are not alerts. Each job
  kind names the drives it takes out of a pool (the old drive in
  `drive-replace`, a spare being removed); members of those drives that turn
  faulty or go away while the job runs raise no event.
  Reshapes, resyncs, and scrubs a job starts show as activity, never as an
  alert. The job's own outcome is the `job.failed` alert.
- Core publishes `health.changed` (the new report's hash) and `health.event`
  (each event) over RPC, which web relays over SSE. `health.get` returns the
  current report and `health.events` the stored history, newest first, kept
  for 90 days.

### Health states

Every drive, tier, pool, and volume has a **condition** and an **activity**,
each with the reasons behind it.

- Conditions, from best to worst: `healthy`, `warning`, `degraded`,
  `failed`.
- Activities: `idle`, `scrubbing`, `syncing`, `reshaping`, `rebuilding`.
- The UI and CLI show one state, the plan's list: `failed` or `degraded`
  when the condition is one of those, except that a degraded object that is
  rebuilding shows `rebuilding`; otherwise the activity if not idle;
  otherwise `warning` or `healthy`. `syncing`, an initial or post-crash
  resync, is added to the plan's list; it is not a loss of redundancy and
  must not look like one.

Per object:

- **Drive:** `failed` when md marked any of its members faulty, or when a
  drive whose label names a pool is gone. `warning` on any SMART threshold
  (below), a failed self-test, or md read errors above the acknowledged
  baseline. Activity `rebuilding` while md rebuilds onto one of its
  partitions.
- **Tier (md array):** `failed` when the array is inactive or has fewer
  working members than it needs to run. `degraded` when it has fewer working
  members than slots. Each tier also reports how many more failures it
  survives: one or zero for RAID1 and RAID5, two, one, or zero for RAID6 and
  three-copy RAID1. Activity from `sync_action`: `recover` is `rebuilding`,
  `reshape` is `reshaping`, `resync` is `syncing`, `check` and `repair` are
  `scrubbing`.
- **Pool:** the worst condition of its tiers, with `warning` added when any
  member or spare drive has a warning, and `failed` when its volume group is
  missing a physical volume. The activity is the most serious of its tiers',
  in the order rebuilding, reshaping, syncing, scrubbing. The pool also
  reports which tiers its spares cover.
- **Volume:** `failed` when its logical volume is not active or its mount
  unit failed; otherwise its pool's condition when that is `degraded` or
  `failed`; otherwise `warning` when it is at least 90 percent full, when a
  btrfs scrub found errors, or when `btrfs device stats` shows errors above
  the acknowledged baseline. Activity `scrubbing` during a btrfs scrub.

Counters that never go down on their own (SMART reallocated sectors, md
read errors, btrfs device errors, scrub errors) are compared with a
baseline stored per drive or volume. The user clears the warning with
**Acknowledge**, which records the current values as the new baseline.
Nothing on the drive or in the kernel is reset.

### Events and alerts

`diffHealth` raises these events. Each has a fixed severity. Events per pool
are held for 10 seconds and merged, so a pulled drive gives one alert, not
one per tier.

| Event                   | Severity                                                   | Raised when                                                                         |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pool.degraded`         | critical if a tier survives no more failures, else warning | a tier of the pool loses redundancy; says which drive and whether a rebuild started |
| `pool.failed`           | critical                                                   | a tier or the volume group can no longer run                                        |
| `pool.rebuild-started`  | info                                                       | a rebuild starts later than the 10 seconds after the loss, such as after a replace  |
| `pool.rebuild-finished` | info, or warning if tiers stay degraded                    | no tier of the pool is rebuilding any more; says which tiers, if any, stay degraded |
| `drive.failed`          | critical                                                   | a drive with no pool tiers fails or disappears, such as a spare                     |
| `drive.warning`         | warning                                                    | a SMART threshold is crossed, a self-test fails, or md read errors rise             |
| `drive.smart-failed`    | critical                                                   | SMART's overall health check fails                                                  |
| `scrub.errors`          | warning                                                    | an md check ends with `mismatch_cnt` above 0, or a btrfs scrub finds errors         |
| `scrub.finished`        | info                                                       | a scrub ends clean (off by default)                                                 |
| `volume.full`           | warning                                                    | a volume reaches 90 percent; raised again only after it falls below 85              |
| `job.failed`            | warning                                                    | a job fails                                                                         |
| `job.finished`          | info                                                       | a job finishes (off by default)                                                     |

The milestone's scenario is `pool.degraded` ("drive sdc failed, rebuilding
onto spare sdh") followed by `pool.rebuild-finished`. Each event is stored in
the history whether or not a webhook is set up, and the dashboard shows the
recent ones. An event does not repeat while its condition lasts.

### Webhook

- One webhook (plan section 1): a URL, an on/off switch, an optional header
  name and value (default name `X-Ohr-Secret`; `Authorization: Bearer ...`
  works too), and an on/off switch per event type. `https` and `http` URLs
  are accepted. The UI warns that `http` sends the header in clear text,
  because Home Assistant on a LAN is a common target.
- Core sends it, not web: core produces the events and has to deliver while
  web is stopped. Settings are stored in the database. The API never
  returns the header value, only whether one is set.
- The body is `application/json`, User-Agent `open-hr/<version>`:

  ```json
  {
    "schema": "open-hr.alert/1",
    "id": "8f0c1e9a-4a40-4f4e-9f53-1b0a7f3d2c11",
    "time": "2026-11-19T16:10:47.012Z",
    "host": "nas",
    "type": "pool.degraded",
    "severity": "critical",
    "title": "Pool tank is degraded",
    "message": "Drive sdc (WDC WD40EFRX, serial WD-WCC7K1234567) failed. Tiers 1 and 2 survive no more failures. Rebuilding onto spare sdh.",
    "text": "Pool tank is degraded: Drive sdc (WDC WD40EFRX, ...) failed. ...",
    "content": "Pool tank is degraded: Drive sdc (WDC WD40EFRX, ...) failed. ...",
    "pool": { "id": "tank", "state": "rebuilding" },
    "drive": { "path": "/dev/sdc", "model": "WDC WD40EFRX", "serial": "WD-WCC7K1234567" },
    "volume": null,
    "test": false
  }
  ```

  `text` and `content` repeat the title and message on one line. They are
  the fields Slack-style webhooks and Discord read, so those work with no
  preset. That is the only concession to particular services. The schema
  string changes only if a field is removed or changes meaning.
- **Delivery.** Alerts go into an outbox table and are sent one at a time,
  oldest first, so a receiver never sees `rebuild-finished` before
  `degraded`. A request times out after 10 seconds. A 2xx answer is success.
  A network error, a timeout, a 5xx, or a 429 is retried after 30 seconds,
  1, 2, 5, 10, and 30 minutes, and then hourly, honouring `Retry-After` up
  to an hour, until 24 hours have passed. Any other answer is a permanent
  failure and is not retried. Both outcomes are logged and shown on the
  settings page with the last status code. The outbox survives restarts and
  holds at most 500 alerts; when full, the oldest `info` alert goes first,
  then the oldest of any severity.
- **Test button.** `alerts.test` sends a `test` event with `"test": true`
  right away, outside the outbox and with no retry, and returns the status
  code or the error, so the user sees at once whether the setup works.
  `ohr alerts test` does the same from the CLI.

### Hot spares

- **A spare belongs to one pool.** It carries that pool's label (decision
  0004) and the pool's tier partitions, bottom up, as many as fit by the rule
  in decision 0011, so it covers those tiers and no others. A drive too
  small for tier 1 is refused. The preview says which tiers it covers and
  that tiers above it will not rebuild on their own.
- **The machine says what is a spare.** A drive of the pool whose tier
  partitions are all md spares is a spare. No role is written to the label
  or the database (plan section 5.4).
- A pool may have any number of spares, under SHR-1 and SHR-2, and RAID1
  tiers get them too. Spares are not shared between pools: md's spare
  groups need tiers of the same size, which different pools do not have.
- **Promotion is the kernel's.** When a member fails, md recovers onto a
  spare partition in that array at once, tier by tier. A spare promoted in
  some tiers and not others is a member in those and a spare in the rest,
  and the pool view shows it so. A spare smaller than the failed drive
  leaves the upper tiers degraded, and `pool.rebuild-finished` says so.
- **`spare-add`** partitions and labels the drive, then `mdadm --add`s each
  partition to its tier. On a healthy tier that makes it a spare; on a
  degraded tier md starts rebuilding onto it, which the preview says. New
  drives pass the same checks as in pool creation.
- **`spare-remove`** `mdadm --remove`s the spare's partitions from every
  tier and stops. Partitions and label stay; nothing is erased (safety rule
  8).
- **Spares and the other jobs.** Because a grow takes whichever spare md
  picks, `pool-expand` removes the pool's spare partitions from a tier
  before growing it and adds them back after its reshape. `pool-expand` also
  accepts one of the pool's own spares as a drive to add: it already has the
  right partitions, so the job removes them from the spare role and grows
  with them. When `drive-replace` puts a new drive in place of one whose
  tiers a spare already took over, the new drive's partitions for those
  tiers become spares.

### Scrubs

- **Scrubs are jobs.** A new `pool-scrub` job runs an md `check` on each
  tier of the pool, one at a time (`echo check > .../md/sync_action`, then
  wait as the reshape wait step does), and then `btrfs scrub start -B` on
  each btrfs volume of the pool, as chosen in its input. Being a job gives
  it history, logs, and progress for free, and holds the pool's job slot so
  that a scrub and a reshape never run together.
- **Jobs can be cancelled,** which the engine does not support yet. A new
  `cancelled` job status, `jobs.cancel` over RPC, and
  `POST /api/v1/jobs/:id/cancel`. Only steps that declare themselves safe to
  cancel can be: the scrub steps, which write `idle` to `sync_action` or run
  `btrfs scrub cancel`. A structural job submitted while a scrub holds the
  pool is refused with `conflict`, and the UI and CLI offer to cancel the
  scrub. A scrub does not start on a pool that is not healthy, and a rebuild
  that starts during it makes md abort the check, which the job reports as
  interrupted, not failed.
- **Results.** For md, the job records `mismatch_cnt` when each tier's check
  ends. Above zero raises `scrub.errors`. Open HR only reports; it does not
  run `repair`, because md rewrites parity or copies without knowing which
  block is right. For btrfs, the corrected and uncorrectable error counts. On a
  single md device, btrfs can correct metadata (duplicated by default) but
  not data, and the alert says the affected files are in the kernel log.
  ext4 volumes have no checksums and are not scrubbed. `e2scrub` needs free
  space in the volume group for a snapshot and is left out.
- **Checks Open HR did not start.** Debian's timer checks every array
  anyway. The monitor sees `sync_action` read `check` without a job and
  shows the tier as scrubbing. When it ends, core records the result as a
  scrub run with source `system` and raises `scrub.errors` if needed. So
  the distribution's checks are reported, never duplicated by default.
- **The scheduler** is a module in core with schedules in the database. A
  schedule is a kind (`md-scrub` per pool, `btrfs-scrub` per volume,
  `smart-short` and `smart-long` for all drives), a frequency (weekly or
  monthly), a weekday, for monthly the week of the month, and a local time.
  That covers the plan's defaults without a cron parser. A run missed while
  core was stopped runs once at start if it is less than a day late. A
  scrub whose pool is busy is retried hourly for a day and then skipped with
  a log line.
- **Defaults.** md scrub per pool: monthly, first Sunday, 02:00, but off
  when Debian's check is enabled (`mdcheck_start.timer` enabled, or
  `AUTOCHECK=true` and `/etc/cron.d/mdadm` present), so arrays are not
  checked twice. The schedules page says which one checks the pool and when.
  btrfs scrub per volume: monthly, third Sunday, 02:00. SMART short test:
  weekly, Saturday, 03:00. SMART long test: off.

### SMART

- smartmontools moves from Recommends to Depends.
- **Polling.** Every 30 minutes core runs `smartctl --json --all -n standby`
  on each physical drive, as `readSystemState` already does, so a sleeping
  drive is not woken. Drives that report no SMART data, such as virtual
  disks and some USB bridges, have SMART `unavailable`, which is not a
  warning. The latest reading of each drive is kept in memory and its
  counters in the database, keyed by serial and WWN, not by device path.
- **Thresholds.** Overall health check failed: `drive.smart-failed`.
  ATA reallocated sectors (5), current pending sectors (197), or offline
  uncorrectable (198) above the baseline: `warning`. Temperature at or above
  a limit (default 55 °C, one setting for all drives) for two readings in a
  row: `warning`, cleared 3 °C below it. NVMe critical warning not zero,
  media errors above the baseline, or percentage used at or above 90:
  `warning`. A failed self-test: `warning`.
- **Self-tests.** `smartctl -t short` or `-t long` on the schedules above,
  on every drive that reports SMART, including spares and unused drives,
  and from `POST /api/v1/drives/:id/smart-test`. A test that is already
  running counts as started. Results are read from the self-test log on
  later polls. Self-tests are not jobs: they belong to a drive, not a pool,
  and the drive runs them in the background without blocking anything.
  Their history is kept in the database.
- `smartd` keeps running. If it starts a test of its own, ours is reported
  as already running.

### SHR-2

- **Growing a RAID6 tier** is `mdadm --add` then
  `mdadm --grow --raid-devices=n+1`, the same steps and wait as RAID5 in
  decision 0011, with no backup file.
- **New tiers under SHR-2** need three members: a three-copy RAID1, or RAID6
  with four or more (plan section 3.3). Two-member tiers stay unused, as the
  planner already does at creation.
- **Three-copy RAID1 to RAID6.** The planner no longer refuses this. A
  `pool-expand` that gives such a tier a fourth member (or more) runs the
  measured path: fail and remove one copy; `--grow --raid-devices=2`;
  `--grow --level=5`; `mdadm --zero-superblock` on the removed copy, which
  is our own partition; `--add` it with the new partition;
  `--grow --raid-devices=3` and wait; `--grow --level=6 --raid-devices=4`
  and wait; `--grow --chunk=512` and wait; then grow by any further new
  members as for any RAID6. Each step's precondition reads the level and
  member count, so a resumed job picks up where it stopped. The removed copy
  is recognised on resume by its partition name.
- **That conversion lowers redundancy for a while.** From the first step to
  the end of the RAID6 reshape, the tier survives one failure, not two. The
  preview says so in its own warning, with the two full reshapes counted in
  the time estimate, and the user confirms it like a destructive step, by
  typing the pool name. It is refused unless every member drive is healthy,
  with no SMART warning.
- **Replacing drives under SHR-2.** A RAID6 tier can have two failed
  members. `drive-replace` still replaces one drive per job; with two
  failures the user runs it twice, and the first may start while the second
  failed drive is still in place. The precondition from decision 0011
  allows a degraded pool when the drive being replaced is one of the reasons
  it is degraded.

### Interfaces

- RPC: `health.get`, `health.events`, `health.acknowledge`, `alerts.get`,
  `alerts.set`, `alerts.test`, `alerts.deliveries`, `schedules.list`,
  `schedules.set`, `pools.previewAddSpare`, `pools.previewRemoveSpare`,
  `pools.previewScrub`, `drives.smartTest`, and `jobs.cancel`; events
  `health.changed`, `health.event`, and `health.progress` (rebuilds and
  checks that no job runs). `jobs.submit` takes the new kinds `spare-add`,
  `spare-remove`, and `pool-scrub`.
- REST, under `/api/v1`, as plan section 5.5: `POST /pools/:id/spares`,
  `DELETE /pools/:id/spares/:driveId`, `POST /pools/:id/scrub`,
  `POST /drives/:id/smart-test`, `GET/PUT /settings/webhook`,
  `POST /settings/webhook/test`, `GET/PUT /settings/schedules`,
  `POST /jobs/:id/cancel`, plus `GET /health`, `GET /health/events`, and
  `POST /health/acknowledge`. Health events go out on `/events` (SSE).
- CLI: `ohr status` shows health states and reasons; `ohr spare add <pool>
  <drive>`, `ohr spare remove <pool> <drive>`, `ohr pool scrub <pool>`,
  `ohr drive smart-test <drive> [--long]`, `ohr alerts show|set|test`,
  `ohr schedule list|set`, `ohr job cancel <id>`, and
  `ohr health ack <drive|volume>`.
- UI: health badges and reasons on the dashboard, drives, pool, and volume
  pages; recent alerts on the dashboard; spares on the pool's tier map with
  the tiers each covers; Add spare and Scrub actions; SMART details and a
  test button on each drive; Webhook and Schedules settings pages with the
  test button and the last deliveries.

### Tests

- Unit: `deriveHealth` and `diffHealth` from fixture snapshots, including
  a failure with and without a spare, a partly covering spare, a RAID6 with
  two failures, a check started by the system, and a restart between two
  reports. The webhook client against a local server: retries, `Retry-After`,
  permanent failures, ordering, the outbox limit. The scheduler's next-run
  arithmetic, including daylight saving changes. SMART thresholds from
  captured `smartctl` fixtures, ATA and NVMe.
- Step builder tests with the fake runner for `spare-add`, `spare-remove`,
  `pool-scrub` and its cancellation, and the RAID6 conversion, including
  resuming from every step.
- Integration on loop devices: add and remove a spare; spare promotion
  after `mdadm --fail`, checked through core's events; an expansion with a
  spare present; an md check with a seeded mismatch; a btrfs scrub; the
  SHR-2 cases in the expansion matrix, including three-copy RAID1 to RAID6
  under writes; the conversion killed and resumed after each step.
- **Failure injection.** A test helper puts a device-mapper `linear` device
  over each loop device, so a test can swap in a `flakey` table
  (intermittent errors, or dropped writes) or an `error` table (a dead or
  pulled drive) with `dmsetup suspend`, `load`, and `resume` while md holds
  it. Cases: a member dies with a spare present, and a local HTTP receiver
  gets `pool.degraded` then `pool.rebuild-finished`, in order, with the
  documented body; the same with the receiver down until the rebuild ends,
  so the retries deliver both; a flaky member whose corrected read errors
  raise `drive.warning`; two members of an SHR-2 tier die and the volume
  still reads back; a member dies during a reshape and during a scrub.
  These tests need the `dm-flakey` module. They skip, saying why, where it
  is missing, and CI loads it with `modprobe` first. They must pass on
  `ohr-dev` before a release (safety rule 12).
- **Acceptance**, by hand on a VM with a pool of three drives and a spare:
  `scripts/pull-drive-check.sh` removes a member with
  `echo 1 > /sys/block/<sd>/device/delete` (a hot unplug, for which udev
  runs `mdadm -If`), then waits for both alerts at a receiver it runs and
  for the pool to be healthy again on the spare. It never touches a drive
  outside the pool it built.

### Breakdown into pull requests

1. This decision.
2. **Health model.** The md sysfs fields in the snapshot, `deriveHealth` and
   `diffHealth` in `shared` with fixtures, `health.get`, and health states in
   `ohr status`. No events or alerts yet.
3. **Monitor and events.** The `/proc/mdstat` poll, the stored report and
   restart diff, the event history, `health.*` RPC and SSE events, job
   suppression, and Acknowledge. Integration test: a member failed with
   `mdadm --fail`, checked through core's events.
4. **Webhook alerts.** Settings, the outbox and retries, the test button,
   the REST routes and CLI, the settings page, and recent alerts on the
   dashboard.
5. **Hot spares.** `spare-add` and `spare-remove`, spares in the pool view
   and tier map, `pool-expand` and `drive-replace` around spares, CLI and UI.
6. **SMART.** The poll, thresholds and baselines, self-tests from the API
   and CLI, the drive page, and smartmontools as a dependency.
7. **Scheduler and scrubs.** Job cancellation, `pool-scrub`, adopting the
   system's checks, the scheduler with the SMART test schedules, and the
   Schedules page.
8. **SHR-2 expansion.** RAID6 growth, the three-copy RAID1 to RAID6
   conversion with its warning, two-failure replaces, and the SHR-2 cases in
   the expansion, replace, and kill-and-resume suites. It depends only on
   PR 5 for spares during a grow, so it can run in parallel with 6 and 7.
9. **Failure injection.** The device-mapper helper, the `dm-flakey` and
   `dm-error` suites, and the CI module load.
10. **Acceptance and release.** `scripts/pull-drive-check.sh`, the alert
    payload documented in the README, the run on a VM, and version 0.3.0.

## Consequences

- One pure function decides health for the dashboard, the CLI, and the
  alerts, and it is testable without root, as the planner is.
- Core reads a small file every 5 seconds forever. That is the price of
  seeing a rebuild finish without depending on mdadm's monitor, and it is
  cheap next to the snapshot refresh it saves.
- Debian keeps mailing root through `mdmonitor` and `smartd`. A user with
  working local mail gets those messages as well as Open HR's. That is left
  alone on purpose: Open HR does not edit the distribution's monitoring.
- Scrubs hold the pool's job slot for hours. A user who needs to replace a
  drive during one cancels it first; the UI offers that in place.
- The SHR-2 conversion is the one operation in Open HR that lowers a tier's
  redundancy on purpose. It is guarded by its own warning and confirmation,
  and it is the case to watch in the M7 kernel matrix.
- Spares are per pool. A machine with two pools needs a spare for each,
  which home users with one pool will not notice.
- Not in M5: more than one webhook, email, repeated reminders while a pool
  stays degraded, md `repair`, ext4 scrubbing, kernel log watching, and
  sharing spares between pools.
