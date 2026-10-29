# Open Hybrid RAID (ohr) — Project Plan

Open Hybrid RAID (Open HR, short form `ohr`) is an open source, userspace tool that reproduces the Synology Hybrid RAID
(SHR) storage layout on stock Linux. It lets a home user mix drives of different
sizes in one redundant pool, use almost all of the capacity, and grow the pool
over time by adding drives or swapping in bigger ones. It is built on the same
standard Linux pieces Synology uses underneath: GPT partitions, `mdadm` software
RAID, and LVM, with btrfs or ext4 on top.

This document is the complete plan: scope, how SHR works, the storage design,
the software architecture, safety rules, testing, packaging, the development
roadmap, and the open source setup. It is written for a solo developer who is
comfortable with Node and TypeScript but new to Linux storage.

---

## 1. Decisions already made

These came out of the planning conversation and are fixed unless revisited on purpose.

| Topic          | Decision                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Product        | Userspace tool reproducing the SHR layout on stock Linux. No kernel code.                                              |
| Redundancy     | SHR-1 (survives one drive failure) and SHR-2 (survives two).                                                           |
| Lifecycle      | Online expansion by adding a drive and by replacing a drive with a larger one.                                         |
| Resilience     | Hot spares, scheduled scrubbing, rebuild monitoring, webhook alerts.                                                   |
| Filesystems    | User chooses btrfs or ext4 per volume. Both supported.                                                                 |
| Extras         | Snapshots, encryption, SSD cache.                                                                                      |
| Platforms      | Debian (12 and 13) and Proxmox VE (8 and 9). Manages data drives only, never the boot drive. Unraid is out of scope.   |
| Interface      | Web UI served from the NAS, plus a CLI. No Electron.                                                                   |
| Stack          | Node.js with TypeScript end to end. React for the UI.                                                                  |
| Compatibility  | No import or export of real Synology pools. On-disk format is ours.                                                    |
| Audience       | Home users.                                                                                                            |
| Team           | One developer. Hours per week and release date not yet set.                                                            |
| Licence        | MIT.                                                                                                                   |
| Name           | Public name "Open Hybrid RAID", short form `ohr` for binaries, services, and device names. Repository stays `open-hr`. |
| Dates          | None for now. Milestones are ordered and sized, not scheduled.                                                         |
| Docs hosting   | GitHub Pages for the documentation site and the apt repository.                                                        |
| Defaults       | Web UI on port 7700, volumes mounted under `/mnt/ohr`.                                                                 |
| Alerts         | One generic webhook that posts a JSON body. No email, no service-specific presets.                                     |
| Telemetry      | None in version 1. Deferred to version 2, opt-in only if it ever ships.                                                |
| Minimum drives | Two for SHR-1, four for SHR-2. No single-drive pools.                                                                  |

---

## 2. Goals and non-goals

### Goals

1. Create a redundant pool from two or more drives of any sizes, with usable
   capacity close to "sum of drives minus the largest" (SHR-1) or "minus the two
   largest" (SHR-2).
2. Grow a pool online, without unmounting, by adding a drive or replacing a drive
   with a larger one, including the case where a bigger drive unlocks a new
   capacity tier.
3. Survive drive failure gracefully: detect it, alert, rebuild onto a hot spare
   or a replacement, and show progress the whole time.
4. Never destroy data by accident. Every destructive step is previewed, confirmed,
   and checked against the real state of the system right before it runs.
5. Be understandable. A user should be able to read what Open HR did to their
   drives in plain `mdadm` and LVM terms, and recover the pool with standard
   tools if Open HR itself disappears.
6. Install with one command on Debian and Proxmox, and upgrade without touching
   data.

### Non-goals (version 1)

- File sharing (Samba, NFS), user accounts for shares, media apps. Open HR mounts
  volumes at a path and stops there. The OS or other tools handle sharing.
- Managing the operating system drive or booting from the pool.
- Removing a drive to shrink a pool. Synology does not support this either.
  Possible later because `mdadm` can reshape to fewer devices, but risky.
- Reading pools created by a real Synology.
- Hardware RAID controllers. Drives must be visible as plain block devices.
- Windows, macOS, or non-Debian Linux. Other distributions will probably work
  but are not tested in version 1.
- Multi-user roles and permissions in the UI. One admin login.

---

## 3. Background: how SHR actually works

This section exists because the developer is new to Linux storage. Read it
twice. Everything else in the plan depends on it.

### 3.1 The Linux storage stack

A Linux storage stack is a set of layers, each one a block device built from the
one below it:

```
  Filesystem (btrfs or ext4)        <- what the user sees, mounted at /mnt/...
  [LUKS encryption, optional]       <- dm-crypt, encrypts everything below the FS
  LVM logical volume (LV)           <- a resizable "virtual partition"
  LVM volume group (VG)             <- a pool of space made of physical volumes
  LVM physical volumes (PV)         <- each one is an md array
  md RAID arrays (mdadm)            <- redundancy, each array spans partitions
  GPT partitions                    <- slices of each drive
  Physical drives (/dev/sda ...)    <- the hardware
```

Standard RAID has one rule that wastes space: every member must be the same size,
so a RAID5 of 4 TB, 8 TB, 8 TB, and 12 TB drives treats every drive as 4 TB.

### 3.2 The SHR trick

SHR removes that waste by slicing drives into _tiers_ and building one md array
per tier:

1. Sort the drives by size.
2. Tier 1 is as big as the smallest drive. Every drive contributes a partition
   of that size. These partitions form one md array.
3. Tier 2 is the difference between the smallest and the next smallest drive.
   Only the drives that still have space contribute. These form a second md array.
4. Repeat until no tier has enough contributing drives to be redundant.
5. Put all the md arrays into one LVM volume group. The user's volume is a
   logical volume that spans all of them.

Worked example, SHR-1 with 4 TB, 8 TB, 8 TB, 12 TB:

| Tier      | Slice size        | Drives contributing        | md level                        | Usable    |
| --------- | ----------------- | -------------------------- | ------------------------------- | --------- |
| 1         | 4 TB              | all 4                      | RAID5 (4 members)               | 12 TB     |
| 2         | 4 TB (8 minus 4)  | the 8, 8, and 12 TB drives | RAID5 (3 members)               | 8 TB      |
| 3         | 4 TB (12 minus 8) | only the 12 TB drive       | none, 1 member is not redundant | 0         |
| **Total** |                   |                            |                                 | **20 TB** |

Total drive space is 32 TB. 32 minus the largest drive (12) is 20. That matches.
The 4 TB left on the 12 TB drive is wasted until another drive at least that
large arrives, at which point tier 3 becomes a RAID1 of two members.

### 3.3 Which md level per tier

| Redundancy | Members in tier | md level used                     | Usable in tier      |
| ---------- | --------------- | --------------------------------- | ------------------- |
| SHR-1      | 1               | none, tier left unused            | 0                   |
| SHR-1      | 2               | RAID1                             | 1 x slice           |
| SHR-1      | 3 or more       | RAID5                             | (n minus 1) x slice |
| SHR-2      | 1 or 2          | none, cannot survive two failures | 0                   |
| SHR-2      | 3               | RAID1 with 3 copies               | 1 x slice           |
| SHR-2      | 4 or more       | RAID6                             | (n minus 2) x slice |

Minimum drives: 2 for SHR-1, 4 for SHR-2. Single-drive pools are refused. These rules reproduce the published
Synology capacity results for every combination checked by hand, but exact
agreement is not a requirement since there is no compatibility goal.

### 3.4 How expansion works on this layout

Adding a drive means, for every tier the new drive is large enough to join:
add a partition to that tier's md array and tell `mdadm` to grow the array by
one member. The kernel reshapes the array online. Then LVM is told the physical
volume got bigger, the logical volume is extended, and the filesystem is grown.
If the new drive has space beyond the existing tiers and at least one other
drive does too, a new tier is created.

Replacing a drive with a bigger one means: fail and remove the old drive's
partitions from every array, partition the new drive, add its partitions, wait
for the rebuild, then treat any leftover space the same as the "new tier" case.
A 2-member RAID1 tier that gains a third member is converted to RAID5 in place,
which `mdadm` supports.

### 3.5 Everything maps to standard commands

Open HR never does anything a sysadmin could not do by hand. The core
operations map to these tools, all of which exist in Debian:

| Operation                                  | Tool                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| Inspect drives and partitions              | `lsblk -J`, `blkid`, `sgdisk -p`                                             |
| Partition a drive                          | `sgdisk` (GPT, type FD00 Linux RAID, named partitions)                       |
| Create, grow, fail, remove, monitor arrays | `mdadm`, `/proc/mdstat`, `/sys/block/md*/md/*`                               |
| Pool the arrays                            | `pvcreate`, `vgcreate`, `vgextend`, `pvresize`                               |
| Create and grow volumes                    | `lvcreate`, `lvextend`, `lvs --reportformat json`                            |
| Encrypt                                    | `cryptsetup luksFormat`, `cryptsetup open`, `cryptsetup resize`              |
| SSD cache                                  | LVM cache (`lvconvert --type cache --cachevol`)                              |
| Filesystems                                | `mkfs.btrfs`, `mkfs.ext4`, `btrfs filesystem resize`, `resize2fs`            |
| Snapshots                                  | `btrfs subvolume snapshot`; ext4 volumes have no snapshots, same as Synology |
| Scrub                                      | `echo check > /sys/block/mdX/md/sync_action`, `btrfs scrub start`            |
| Drive health                               | `smartctl -j`                                                                |
| Hotplug events                             | `udevadm monitor` or the udev netlink socket                                 |
| Mount at boot                              | systemd mount units generated by Open HR                                     |

---

## 4. Storage design

### 4.1 Layout planner

The planner is a pure TypeScript function with no side effects. Input: a list of
drives with sizes and the chosen redundancy. Output: a complete layout
description: per-drive partition table, per-tier md array spec, VG and LV spec.
It is also the function that answers "what would happen if I added this drive"
and "what is my usable capacity". Because it is pure it gets exhaustive unit
tests and property-based tests (for example: usable capacity never exceeds sum
minus largest, every tier has the minimum member count, partitions never overlap).

Planner rules:

- Partitions aligned to 1 MiB. Keep a 64 MiB reserve at the end of every drive
  so a replacement drive that is a few megabytes smaller still fits (drives of
  the same nominal size differ by a little between vendors).
- Partition number k holds tier k on every drive, so the same tier is always the
  same partition number. Partition 1 is reserved for a 16 MiB Open HR label
  partition that holds a JSON descriptor (pool id, drive id, layout version).
  This makes drives self-describing even if md and LVM metadata is damaged.
  Partitions are named `ohr-<poolId>-t<tier>` and `ohr-<poolId>-label`
  (decision 0004).
- Drives whose usable sizes differ by less than 1 GiB share a tier, so nearly
  equal drives from different vendors do not create tiny arrays (decision 0003).
- md arrays use metadata 1.2, an internal write-intent bitmap (fast recovery
  after an unclean shutdown), and a 512 KiB chunk.
- md arrays are named `ohr_<poolId>_t<tier>` and appear as `/dev/md/ohr_<poolId>_t<tier>`.
- The VG is named `ohr-<poolId>`. Volumes are LVs named by the user.
- The planner also produces a "diff" between the current layout and the target
  layout, which becomes the step list for a job (section 6.4).

### 4.2 Pool creation

1. Validate drives: not the OS drive, not mounted, not part of an existing md or
   LVM, no filesystem signatures unless the user ticks "wipe".
2. Write GPT and partitions on every drive.
3. Create every tier's md array. Arrays start in "resync" state and are usable
   immediately; the UI shows resync progress.
4. `pvcreate` each array, `vgcreate` the VG.
5. Create the first volume (section 4.3).

### 4.3 Volumes

A volume is an LV plus optional LUKS plus a filesystem plus a mount point.
Version 1 allows multiple volumes per pool, each with its own filesystem choice
and encryption choice. Default mount point is `/mnt/ohr/<volume>`.

Stack per volume: LV, then LUKS if encrypted, then filesystem. Putting LUKS
above LVM means the SSD cache (which lives inside LVM) only ever holds encrypted
blocks, which is the safe default.

Encryption uses LUKS2 with a user passphrase. The key is not stored on the
system by default; the volume must be unlocked after a reboot via the UI or
CLI. An optional "keyfile on the OS drive" mode gives auto-unlock at the cost
of protection against OS-drive theft. The UI must explain this trade-off.

### 4.4 Expansion jobs

**Add drive.** Precondition: every array clean, no other job on the pool. Steps:
partition the drive, for each tier it joins run `mdadm --add` then `mdadm --grow
--raid-devices=n+1`, wait for reshape, `pvresize`, create any new tier, `vgextend`
if needed, `lvextend`, grow LUKS if present, grow the filesystem. Reshape can
take days on large drives; the job survives daemon restarts because the kernel
keeps reshaping on its own and the daemon simply re-attaches to progress.

**Replace drive with a larger one.** Two flows:
- Drive still works: add the new drive as a spare to every array the old one is
  in, then `mdadm --replace` the old one. The array stays fully redundant the
  whole time. Then remove the old drive and handle leftover space.
- Drive is dead or missing: `mdadm --remove`, partition the new drive, `mdadm
  --add`, wait for rebuild, then handle leftover space.

**New tier from leftover space.** When two or more drives have unallocated space
beyond the last tier, create partition and array for the new tier (RAID1 for 2
members under SHR-1, 3-copy RAID1 for 3 members under SHR-2), `pvcreate`,
`vgextend`, extend the volume. When a RAID1 tier gets a third member under
SHR-1, convert it with `mdadm --grow --level=5`.

### 4.5 Hot spares

A hot spare is a drive partitioned like the largest drive in the pool, with
each partition added as a spare to the matching tier's array. A spare smaller
than the largest drive only covers the tiers it can fit, and the UI says so.
`mdadm` promotes spares automatically on failure. The spare must be removed from
the spare role before it can be used for expansion.

### 4.6 Scrubbing and health

- md scrub: scheduled per pool (default monthly, Sunday 02:00), runs `check` on
  each array one at a time, reports mismatch counts.
- btrfs scrub: scheduled per btrfs volume, verifies checksums and reports
  corrected and uncorrectable errors.
- SMART: polled every 30 minutes plus a short self-test weekly. Thresholds on
  reallocated sectors, pending sectors, temperature.
- Health states for drives, arrays, pools, and volumes: healthy, warning,
  degraded, failed, rebuilding, reshaping, scrubbing.

### 4.7 SSD cache

Uses LVM cache so no extra layer is introduced. One or two SSDs. With two SSDs,
an md RAID1 is built first so a cache SSD failure cannot lose data. Modes:
writethrough (default, safe with a single SSD) and writeback (only allowed when
the cache is on RAID1). Cache can be attached to and detached from a volume
online.

### 4.8 Snapshots

btrfs volumes get read-only snapshots via subvolumes. Each btrfs volume is
created with a `@data` subvolume mounted as the volume root and a `.snapshots`
subvolume for snapshots, so snapshots can be listed and browsed. Schedules
(hourly, daily, weekly) with retention counts. ext4 volumes have no snapshots.
LVM thin snapshots for ext4 are a possible later addition.

### 4.9 Boot-time assembly and mounting

md arrays assemble on boot via udev and `/etc/mdadm/mdadm.conf`, which Open HR
keeps updated (followed by `update-initramfs -u` on Debian so names stay stable).
LVM activates automatically. Open HR writes a systemd mount unit per volume with
`nofail` so a missing pool never blocks boot. Encrypted volumes wait for unlock.
The daemon reconciles on start: it reads the real system state and compares it
to what it expects.

### 4.10 Proxmox notes

Proxmox VE is Debian with its own kernel and heavy LVM use. Open HR must:
- Use its own VG name prefix (`ohr-`) and never touch `pve`.
- Respect `/etc/lvm/lvm.conf` filters; md devices are not excluded by default.
- Offer a documented way to expose an Open HR volume as Proxmox storage (a
  directory storage pointed at the mount path). That is documentation, not code.

---

## 5. Software architecture

### 5.1 Processes

Two long-running processes plus a CLI, all TypeScript, all in one repository.

```
 Browser  --HTTPS-->  ohr-web (unprivileged user "ohr")
                          |  typed RPC over unix socket /run/ohr/core.sock
 ohr CLI  -----------> ohr-core (root, systemd service)
                          |  spawns: mdadm, sgdisk, lvm, mkfs, cryptsetup, smartctl ...
                       Linux kernel
```

- **ohr-core** is the only thing that runs as root. It exposes a small, strictly
  typed RPC API over a unix socket with permissions limited to the `ohr` group.
  It owns the job engine, the planner, the system state cache, monitoring, and
  the SQLite database.
- **ohr-web** serves the React UI and a REST plus Server-Sent Events API, handles
  authentication and sessions, and forwards validated requests to core. If web
  is compromised, the attacker still has to go through core's API, which refuses
  anything outside its schema.
- **ohr CLI** talks to core over the same socket. Every UI action has a CLI
  equivalent, which makes scripting and testing easier and gives users a
  fallback if the UI is down.

### 5.2 Monorepo layout

```
open-hr/
  package.json              pnpm workspace root
  pnpm-workspace.yaml       workspace packages and version catalog
  turbo.json                task pipeline
  packages/
    shared/                 zod schemas, types, planner (pure), parsers (pure)
    core/                   root daemon: job engine, executors, monitor, db
    web/                    fastify server: REST, SSE, auth, serves ui build
    ui/                     react + vite app
    cli/                    ohr command
  deploy/
    debian/                 nfpm config, systemd units, postinst, udev rules
    docker/                 optional privileged container image
  test/
    fixtures/               captured outputs of real commands
    integration/            loop-device tests that run real mdadm and lvm
    e2e/                    playwright tests against the ui
  docs/
    PLAN.md                 this file
    ...                     user and developer docs (later a docs site)
  .github/workflows/        ci, release, docs
```

### 5.3 Technology choices

| Concern          | Choice                                                                    | Why                                                                |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Runtime          | Node.js current LTS (26 at time of writing)                               | ESM, stable `fetch`, good child process APIs                       |
| Language         | TypeScript strict mode                                                    | catches whole classes of bugs before they reach a drive            |
| Package manager  | pnpm 12 workspaces with a version catalog                                 | fast, strict dependency isolation                                  |
| Task runner      | Turborepo                                                                 | runs package tasks in dependency order with caching                |
| Validation       | zod                                                                       | one schema per API shape, shared between core, web, ui, cli        |
| HTTP server      | Fastify                                                                   | fast, typed, first-class schema validation, SSE is easy            |
| Process spawning | Node's `execFile` with argument arrays, never a shell, fixed environment  | removes injection risk entirely; see decision 0003                 |
| Database         | SQLite via better-sqlite3                                                 | zero ops, single file, transactional                               |
| UI               | React, Vite, Tailwind, TanStack Query                                     | standard, fast to build, easy for contributors                     |
| Testing          | Vitest, fast-check for property tests, Playwright for e2e                 |                                                                    |
| Lint and format  | Biome, `all` preset, warnings fail, sorted import groups, no barrel files | one strict tool instead of ESLint plus Prettier; see decision 0002 |
| Bundling         | esbuild or tsup to one file per package                                   | simple deployment                                                  |
| Packaging        | nfpm to build `.deb`, bundling the Node binary under `/opt/ohr`           | no dependency on the distro's Node version                         |
| Docs             | Starlight (Astro) later                                                   |                                                                    |

### 5.4 Core daemon internals

- **System state reader.** One module that turns `lsblk -J`, `mdadm --detail --export`,
  `/proc/mdstat`, `lvs`/`vgs`/`pvs --reportformat json`, `blkid`, `findmnt -J`,
  and `smartctl -j` into one typed snapshot of the machine. Refreshed on udev
  events and on a timer. This snapshot is the source of truth. The database
  stores only what the system cannot tell us: pool names, user intent,
  schedules, job history, alert settings.
- **Executors.** Thin wrappers, one per external tool, with typed arguments and
  typed parsed output. They are the only place external commands are invoked.
  Each one has a dry-run mode that returns the command line it would run.
- **Planner.** Pure. Lives in `shared` so the UI can show previews without
  calling the server for arithmetic.
- **Job engine.** Persistent queue, one running job per pool. A job is a list
  of steps. Each step has a precondition check, an action, a postcondition
  check, and a progress reader. Steps are idempotent: re-running a completed
  step is a no-op because the precondition detects it is done. On daemon start,
  unfinished jobs are resumed from their first incomplete step. Progress and
  log lines stream to the UI over SSE.
- **Monitor.** Watches `/proc/mdstat`, udev, SMART, filesystem errors, and
  disk space. Produces events. Events feed health state and alerts.
- **Alerts.** One generic outgoing webhook: an HTTPS POST with a documented
  JSON body (event type, severity, pool, drive, message, timestamp) and an
  optional shared secret header. Users point it at ntfy, Discord, Home
  Assistant, or anything else that accepts a POST. A "send test" button
  verifies the setup. Alert rules: drive failed, array degraded, rebuild started and finished,
  scrub found errors, SMART warning, volume above 90 percent full, job failed.
- **Scheduler.** Cron-like schedules stored in SQLite for scrubs, SMART tests,
  and snapshots.

### 5.5 Web server and API

REST under `/api/v1`, JSON everywhere, zod-validated on both ends.

| Resource  | Endpoints                                                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth      | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`                                                                                                                                                                                                                            |
| Drives    | `GET /drives`, `GET /drives/:id`, `POST /drives/:id/smart-test`, `POST /drives/:id/wipe`                                                                                                                                                                                           |
| Pools     | `GET /pools`, `POST /pools` (create), `GET /pools/:id`, `POST /pools/:id/plan` (preview add or replace), `POST /pools/:id/add-drive`, `POST /pools/:id/replace-drive`, `POST /pools/:id/spares`, `DELETE /pools/:id/spares/:driveId`, `POST /pools/:id/scrub`, `DELETE /pools/:id` |
| Volumes   | `GET /pools/:id/volumes`, `POST /pools/:id/volumes`, `PATCH /volumes/:id`, `POST /volumes/:id/unlock`, `POST /volumes/:id/cache`, `DELETE /volumes/:id/cache`, `DELETE /volumes/:id`                                                                                               |
| Snapshots | `GET /volumes/:id/snapshots`, `POST /volumes/:id/snapshots`, `DELETE /snapshots/:id`, `PUT /volumes/:id/snapshot-schedule`                                                                                                                                                         |
| Jobs      | `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/cancel` (only for steps that are safe to cancel)                                                                                                                                                                                     |
| Events    | `GET /events` (SSE stream of state changes, job progress, alerts)                                                                                                                                                                                                                  |
| Settings  | `GET/PUT /settings/webhook`, `POST /settings/webhook/test`, `GET/PUT /settings/schedules`                                                                                                                                                                                          |
| System    | `GET /system` (version, kernel, tool versions, dependency check)                                                                                                                                                                                                                   |

Authentication: one admin account created at first run via a token printed
by the installer. Password hashed with argon2. Session cookie, `HttpOnly`,
`SameSite=Strict`. HTTPS with a self-signed certificate generated at install,
user can supply their own. Rate limiting on login. Listens on port 7700 by
default.

### 5.6 Web UI

Pages:

1. **Dashboard.** Pool health, capacity bar, active jobs, recent alerts.
2. **Drives.** Every drive with model, serial, size, temperature, SMART status,
   role (pool member, spare, cache, unused, OS). Physical slot if the system
   exposes it.
3. **Pool.** Visual tier map: drives as columns, tiers as horizontal bands,
   showing exactly where each partition and md array sits. This single diagram
   is the thing that makes SHR understandable and should be the showpiece.
   Actions: add drive, replace drive, add spare, scrub, destroy.
4. **Volumes.** Each volume with filesystem, encryption, cache, mount point,
   usage. Actions: create, resize is automatic, lock and unlock, attach cache,
   snapshots tab.
5. **Jobs.** Running and past jobs with step-by-step progress, ETA from
   `/proc/mdstat` speed, full log.
6. **Settings.** Webhook, schedules, account, certificate, backup and restore of
   the Open HR configuration database.
7. **Wizards.** Create pool and add drive are multi-step with a preview page
   that shows the before-and-after capacity and the exact commands that will
   run. Destructive steps require typing the pool name.

Dark mode, keyboard accessible, works on a phone because home users will check
rebuild progress from the couch.

---

## 6. Safety model

Data loss is the one failure that ends the project's reputation. These rules
are not optional and tests enforce them.

1. **No shell strings.** Every external command is an argument array. A drive
   path is validated against the live `lsblk` output before use.
2. **Refuse to touch the OS drive** or any drive with a mounted filesystem,
   an active md member, or an active PV not owned by Open HR. Detection is by
   live inspection, not by remembered state.
3. **Signatures mean stop.** A drive with any filesystem, RAID, or LVM
   signature is rejected unless the user explicitly chooses "wipe this drive",
   and the UI shows what was found.
4. **Preview before commit.** Every job shows its step list and the exact
   commands. The user confirms. The confirmation includes a hash of the system
   state at preview time; if the state changed before execution, the job is
   rejected and the preview must be regenerated.
5. **Preconditions re-checked at execution** for every step, not just at job
   start. A reshape step refuses to run on a degraded array.
6. **One job per pool, serialized.** No concurrent structural changes.
7. **Idempotent steps and resumable jobs.** A crash mid-job never leaves the
   system in a state the daemon cannot recognise on restart.
8. **Nothing is deleted on failure.** A failed job stops and reports. It never
   "cleans up" by removing partitions or arrays. The user decides.
9. **Standard layout.** Everything Open HR builds can be assembled, mounted,
   and recovered with plain `mdadm` and LVM on any Linux live USB. The
   documentation includes that recovery procedure.
10. **Config backup.** The SQLite database and the per-drive label partition
    together are enough to reconstruct the pool description.
11. **Integration tests on real kernels** for every structural operation,
    using loop devices (section 8), before any release.
12. **Release gating.** A release is blocked unless the full integration suite,
    including the failure-injection tests, passes.

---

## 7. Packaging, install, and upgrade

- **Package.** A single `.deb` named `open-hr` built with nfpm. Installs to
  `/opt/ohr` with a bundled Node binary, two systemd units (`ohr-core.service`,
  `ohr-web.service`), a udev rule to notify core of hotplug, config in
  `/etc/ohr`, data in `/var/lib/ohr`, logs via journald.
- **Dependencies** declared in the package: `mdadm`, `lvm2`, `btrfs-progs`,
  `e2fsprogs`, `gdisk`, `cryptsetup`, `smartmontools`, `util-linux`.
- **Install.** `curl -fsSL https://.../install.sh | sudo bash` that adds an apt
  repository, or a direct `dpkg -i`. First run prints a one-time setup URL
  and token.
- **Upgrade.** `apt upgrade`. Database migrations run on core start. Running
  jobs are resumed. Layout version in the label partition lets future
  versions detect old layouts.
- **Uninstall** never touches pools. Documentation explains that pools keep
  working with plain Linux.
- **Docker image** (privileged, host network and `/dev` mounted) is a secondary
  target for people who prefer it, after the `.deb` is solid.
- **Versioning.** Semantic versioning. Pre-1.0 releases are explicitly labelled
  as "do not trust with only copy of your data".

---

## 8. Testing strategy

Because the developer is new to Linux storage, tests do double duty as the
learning tool and the safety net.

### 8.1 Unit tests (fast, no root)

- Planner: exhaustive cases for 2 to 12 drives across SHR-1 and SHR-2,
  property tests for capacity bounds and non-overlap, golden tests against
  the worked examples in section 3.
- Parsers: fixture files captured from real `lsblk`, `mdadm`, `lvs`, `smartctl`,
  `/proc/mdstat` output, including degraded, reshaping, and failed states.
- Job engine: step ordering, resume after simulated crash, precondition
  rejection, using a fake executor that records commands.

### 8.2 Integration tests (real kernel, root, loop devices)

Loop devices turn ordinary files into block devices, so a 6-drive SHR pool
can be built from six sparse files of 256 MiB to 1 GiB in a few seconds.
`mdadm`, LVM, btrfs, ext4, LUKS, and LVM cache all work on loop devices.

Scenarios, each one a full real run of the daemon's executors:

- Create pool for every combination of 2 to 6 drives with mixed sizes, SHR-1 and SHR-2.
- Add a drive that joins existing tiers only; add a drive that creates a new tier.
- Replace a smaller drive with a larger one, both live and failed variants.
- RAID1 to RAID5 tier conversion.
- Hot spare promotion after `mdadm --fail`.
- Scrub run and mismatch reporting.
- Volume create, grow, encrypt, unlock, cache attach and detach, snapshot and
  restore.
- Daemon killed mid-job and restarted, for every job type.
- I/O errors injected with device-mapper `dm-flakey` and `dm-error` targets
  underneath a member to simulate a dying drive.
- Reboot simulation: stop daemon, `mdadm --stop` everything, deactivate LVM,
  then start daemon and assert full reassembly and mount.

These run in GitHub Actions on `ubuntu-latest` with `sudo` (loop devices and
mdadm are available there) and nightly in a Debian 12, Debian 13, and Proxmox
VM via a self-hosted runner or a scheduled VM job. Data integrity is checked
by writing files with known hashes before an operation and verifying after.

### 8.3 End-to-end tests

Playwright drives the UI against a core running on loop devices. Covers the
wizards, confirmation flows, job progress rendering, and alert settings.

### 8.4 Manual release checklist

A real machine with at least four physical drives of mixed sizes, running the
full lifecycle once per release, including a physical drive pull.

---

## 9. Development environment and learning path

### 9.1 Environment

- A Debian 13 VM with 2 CPUs, 4 GB RAM, a 20 GB OS disk, and six extra virtual
  disks of 2, 4, 4, 6, 8, and 8 GB. On Proxmox this is trivial; otherwise
  VirtualBox, UTM, or Multipass work. Snapshot the VM so it can be reset.
- VS Code with Remote SSH into the VM. Code lives in the VM.
- `pnpm dev` starts core under `sudo`, web as the normal user, and Vite for
  the UI with hot reload.
- A second VM for Proxmox 9 once packaging starts.

### 9.2 Learning path (do this before writing the core)

Each item is a hands-on session in the VM, roughly two to four hours. The
Arch Wiki pages for mdadm, LVM, btrfs, and dm-crypt are the best references
even on Debian.

1. Block devices: `lsblk`, `blkid`, `/dev`, `/sys/block`. Create loop devices
   with `losetup` from sparse files.
2. GPT partitioning with `sgdisk`, partition types, alignment, naming.
3. `mdadm`: build RAID1, RAID5, RAID6 from loop devices. Read `/proc/mdstat`.
   Fail a member, remove it, add a new one, watch the rebuild. Grow a RAID5 by
   one member. Convert RAID1 to RAID5. Stop and reassemble.
4. LVM: `pvcreate`, `vgcreate`, `lvcreate`, `lvextend`, `pvresize`, JSON
   reporting. Put two md arrays in one VG and make one LV span both.
5. Filesystems: `mkfs.btrfs`, `mkfs.ext4`, mount, online grow, btrfs
   subvolumes and snapshots, btrfs scrub, `resize2fs`.
6. Build the full SHR layout by hand for the six virtual disks, following
   section 3. Then add a seventh disk by hand. This is the single most
   valuable exercise in the plan.
7. systemd: write a service unit and a mount unit. Journald. Unix sockets.
8. udev: watch `udevadm monitor` while attaching a disk. Read SMART with
   `smartctl -j`.
9. LUKS: format, open, resize, keyfiles.
10. LVM cache: attach a loop "SSD" as a cache to an LV, detach it.
11. Failure injection with `dmsetup` and the `flakey` target.

Keep a notes file of every command used. Those notes become the first draft
of the recovery documentation.

---

## 10. Roadmap

Sized for one developer. Effort is relative: S is about a week of evenings,
M a few weeks, L one to two months, XL more. Each milestone has a definition
of done. Nothing in a later milestone starts until the earlier one's done list
is green.

### M0. Foundations (M)

- Learning path complete, SHR built by hand in the VM.
- Repository scaffold: pnpm monorepo, TypeScript strict, Biome, Vitest, CI
  running on every push.
- MIT licence, README, CONTRIBUTING, Code of Conduct, issue templates,
  security policy.
- Done when: CI is green on an empty project and the developer can explain
  every layer of the stack from memory.

### M1. Planner and inspectors (M)

- `shared`: planner with full unit and property tests, capacity calculator.
- `core`: system state reader with parsers for `lsblk`, `mdadm`, `/proc/mdstat`,
  LVM JSON, `blkid`, `findmnt`, `smartctl`, backed by fixtures.
- `cli`: `ohr status` and `ohr plan` showing the real machine and a proposed layout.
- Done when: `ohr plan` on the VM prints the same layout as the hand-built one.

### M2. Create pool, SHR-1, one volume (L)

- Executors for `sgdisk`, `mdadm`, LVM, `mkfs`, mount, systemd units,
  `mdadm.conf`.
- Job engine with persistence, resume, preview, preconditions.
- `ohr pool create`, `ohr volume create`, with btrfs and ext4.
- Integration tests on loop devices for every drive combination.
- Done when: a pool survives a VM reboot and the full create suite passes in CI.

### M3. Daemon split, web API, and read-only UI (L)

- `core` as root daemon with unix socket RPC. `web` with auth, REST, SSE.
- UI: dashboard, drives, pool page with the tier diagram, volumes, jobs.
- `.deb` packaging, install script, first installable pre-release (0.1).
- Done when: a fresh Debian VM goes from `dpkg -i` to a created pool using
  only the browser.

### M4. Expansion (L)

- Add drive, replace drive (live and failed), new tier creation, RAID1 to
  RAID5 conversion, volume and filesystem auto-grow.
- Crash and resume tests for every expansion job.
- Done when: the add and replace suites pass, including kill-and-resume.

### M5. Resilience (M)

- SHR-2. Hot spares. Scheduled md and btrfs scrubs. SMART polling and tests.
- Monitor and health states. Generic webhook alerts with a test button.
- Failure-injection tests with `dm-flakey`.
- Done when: pulling a drive from the VM produces an alert, a rebuild onto
  the spare, and a second alert on completion, with no user action.

### M6. Volume features (M)

- LUKS encryption with unlock flow. Snapshots with schedules and retention.
  LVM SSD cache with single and mirrored SSD.
- Done when: all three have integration tests and UI flows.

### M7. Hardening and 1.0 (L)

- Proxmox 9 testing and documentation. Debian 12 and 13 matrix.
- Recovery documentation with a live-USB walkthrough, tested by following it.
- Config backup and restore. Upgrade testing from 0.x.
- Accessibility pass, mobile layout, dark mode.
- Docs site on GitHub Pages. Release automation. Manual checklist on
  physical hardware.
- Done when: the release checklist is signed off and the developer would
  put their own data on it.

### Later (not scheduled)

Docker image, Samba and NFS sharing, shrink by drive removal, LVM thin
snapshots for ext4, multi-user roles, Prometheus metrics, email alerts,
opt-in anonymous telemetry, other distributions, ARM boards.

---

## 11. Repository and open source setup

- **Licence.** MIT, `LICENSE` at the root, SPDX headers not required.
- **README.** What it is, a screenshot of the tier diagram, the three-line
  install, the data safety status, and a link to docs.
- **CONTRIBUTING.** How to set up the VM, run tests, the rule that every
  structural change needs an integration test, commit style (Conventional
  Commits so the changelog can be generated), and the pull request checklist.
- **CODE_OF_CONDUCT.** Contributor Covenant.
- **SECURITY.md.** Private reporting via GitHub security advisories, response
  target of seven days.
- **Issue templates.** Bug report (requires `ohr support-bundle` output, which
  collects logs and sanitised state), feature request, and a "data loss"
  template that is pinned and triaged first.
- **Governance.** Single maintainer for now. Decisions recorded in
  `docs/decisions/` as short architecture decision records. Revisit when a
  second regular contributor appears.
- **Branching.** `main` is always releasable. Feature branches, squash merge,
  CI required.
- **Documentation.** Starlight site built from `docs/` and published to
  GitHub Pages by `docs.yml` on every push to `main`.
- **Releases.** GitHub Releases with the `.deb` attached, apt repository
  hosted on GitHub Pages, changelog generated from commits. Every pre-1.0
  release note repeats the "not yet trusted with sole copies" warning.
- **CI workflows.** `ci.yml` (lint, typecheck, unit, integration on loop
  devices, e2e), `nightly.yml` (VM matrix), `release.yml` (build `.deb`,
  publish), `docs.yml`.
- **Community.** GitHub Discussions for questions. A roadmap issue pinned.
  Share on r/DataHoarder, r/homelab, and the Proxmox forum once M3 ships
  and clearly label it as pre-release.
- **Naming.** Public name "Open Hybrid RAID", short form `ohr` everywhere in
  code, services, and device names. Repository stays `open-hr`.
- **Project description** on GitHub: "Synology Hybrid RAID for any Linux box.
  Mix drive sizes, keep the capacity, grow over time. Built on mdadm and LVM."

---

## 12. Risks and mitigations

| Risk                                                        | Impact                     | Mitigation                                                                                                                         |
| ----------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Bug destroys user data                                      | Project is dead            | Safety model (section 6), loop-device integration tests, failure injection, pre-1.0 warnings, release gating                       |
| mdadm reshape edge cases on old kernels                     | Stuck or failed expansion  | Support only Debian 12 and 13 kernels, test each, require `--backup-file` where the kernel needs it, document kernel minimums      |
| Developer's lack of storage experience                      | Wrong assumptions baked in | Learning path first, hand-built SHR before code, planner reviewed against the Synology calculator, ask for review on r/DataHoarder |
| Solo developer burnout or abandonment                       | Users stranded             | Standard on-disk layout means pools work without Open HR; recovery docs from day one                                               |
| Running a Node process as root                              | Security exposure          | Privilege separation, unix socket with group permissions, zod validation, no shell strings, minimal dependency tree audited in CI  |
| Node runtime version drift on Debian                        | Breakage on upgrade        | Bundle the Node binary in the `.deb`                                                                                               |
| Proxmox kernel or LVM config differences                    | Pool not assembling        | Nightly Proxmox VM tests, explicit VG naming, documented `lvm.conf` interactions                                                   |
| Scope creep toward a full NAS OS                            | Never ships                | Non-goals list, roadmap gates                                                                                                      |
| Drive replacement with a slightly smaller "same size" drive | Replacement refused        | 64 MiB end-of-drive reserve in the planner                                                                                         |
| Reshape takes days and the user reboots                     | Confusion, risk            | Kernel resumes reshape on its own; daemon re-attaches; UI explains clearly                                                         |

---

## 13. Open items

All planning questions are resolved: no dates for now, GitHub Pages for docs
and the apt repository, port 7700 and `/mnt/ohr`, one generic webhook for
alerts, no telemetry in version 1, two drives minimum for SHR-1, public name
"Open Hybrid RAID" with `ohr` as the short form.

New questions go in `docs/decisions/` as short architecture decision records
once development starts.

---

## Appendix A. Capacity cheat sheet

For a quick check of what the planner should produce:

- SHR-1 usable is approximately total minus the largest drive, as long as every
  tier that matters has at least two members.
- SHR-2 usable is approximately total minus the two largest drives, as long as
  every tier that matters has at least three members.
- Space on a drive that no other drive can match is unused until a drive at
  least that large is added.

Examples (TB):

| Drives         | SHR-1 | SHR-2       |
| -------------- | ----- | ----------- |
| 4, 4           | 4     | not allowed |
| 4, 8           | 4     | not allowed |
| 4, 8, 8        | 12    | not allowed |
| 4, 8, 8, 12    | 20    | 12          |
| 4, 8, 12, 12   | 24    | 12          |
| 8, 8, 8, 8     | 24    | 16          |
| 2, 4, 6, 8, 10 | 20    | 12          |

## Appendix B. Command walkthrough for the worked example

Three drives of 4, 8, and 8 TB, SHR-1, one btrfs volume. This is what Open HR
runs, and what a user would run by hand to recreate it.

```
# partition: p1 label (16 MiB), p2 tier 1 (4 TB minus reserve), p3 tier 2 (4 TB) on the 8 TB drives
sgdisk -Z /dev/sda
sgdisk -n 1:0:+16M  -t 1:8300 -c 1:ohr-p1-label /dev/sda
sgdisk -n 2:0:+3999G -t 2:FD00 -c 2:ohr-p1-t1 /dev/sda
# same for sdb and sdc, plus:
sgdisk -n 3:0:+4000G -t 3:FD00 -c 3:ohr-p1-t2 /dev/sdb
sgdisk -n 3:0:+4000G -t 3:FD00 -c 3:ohr-p1-t2 /dev/sdc

# arrays
mdadm --create /dev/md/ohr_p1_t1 --metadata=1.2 --bitmap=internal --chunk=512 \
      --level=5 --raid-devices=3 /dev/sda2 /dev/sdb2 /dev/sdc2
mdadm --create /dev/md/ohr_p1_t2 --metadata=1.2 --bitmap=internal --chunk=512 \
      --level=1 --raid-devices=2 /dev/sdb3 /dev/sdc3

# lvm
pvcreate /dev/md/ohr_p1_t1 /dev/md/ohr_p1_t2
vgcreate ohr-p1 /dev/md/ohr_p1_t1 /dev/md/ohr_p1_t2
lvcreate -l 100%FREE -n data ohr-p1

# filesystem and mount
mkfs.btrfs -L data /dev/ohr-p1/data
mkdir -p /mnt/ohr/data && mount /dev/ohr-p1/data /mnt/ohr/data

# persist
mdadm --detail --scan >> /etc/mdadm/mdadm.conf && update-initramfs -u
```

Usable: tier 1 is 2 x 4 TB (RAID5 of 3) = 8 TB, tier 2 is 4 TB (RAID1) = 4 TB,
total 12 TB from 20 TB of drives. 20 minus the largest 8 is 12.
