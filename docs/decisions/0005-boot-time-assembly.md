# 0005. Boot-time assembly and mount units

- Status: Accepted
- Date: 2026-10-29

## Context

Plan section 4.9 says Open HR keeps `/etc/mdadm/mdadm.conf` updated, runs
`update-initramfs -u` after each change, and writes a systemd mount unit per
volume with `nofail`. Writing those executors raised three questions: whether
to edit a file Debian generates and the user may have edited, whether the
initramfs needs to know about Open HR arrays at all, and what `nofail` means
for a native unit file rather than an fstab line.

## Decision

### mdadm configuration

- Each pool gets its own file, `/etc/mdadm/mdadm.conf.d/ohr-<pool>.conf`,
  with one `ARRAY` line per tier as `mdadm --detail --scan` prints it. mdadm
  reads that directory after the main file. The main file is never touched.
- `update-initramfs` is not run. Debian's initramfs hook copies only the main
  file, and an Open HR array is never the root filesystem. Arrays carry
  `homehost=any` (decision 0004), so udev's incremental assembly gives them
  their `/dev/md/ohr_<pool>_t<k>` names with no configuration at all. The
  file exists for `mdadm --assemble --scan` by hand and as documentation of
  the pool.

### Mount units

- Each volume gets a native unit at `/etc/systemd/system/<name>.mount`, where
  the name is the mount point escaped as `systemd-escape --path` does. The
  unit sets `What=` to the logical volume path, `Type=`, `Options=`
  (`subvol=@data` for btrfs, `defaults` for ext4), and
  `WantedBy=multi-user.target`.
- Wanted, not required, is what `nofail` means for a native unit: a missing
  pool fails its own unit and boot carries on.
- Units are installed with `systemctl daemon-reload` and
  `systemctl enable --now`, and removed with `systemctl disable --now`,
  deleting the file, and another `daemon-reload`. `/etc/fstab` is never
  edited.

## Consequences

- A user recovering by hand finds every pool's arrays in one short file and
  can assemble with or without it.
- The integration test stands in for a reboot by deactivating the volume
  group, stopping the arrays, assembling from the pool's file, and
  reactivating. A real reboot of the VM remains the M2 acceptance check.
- The unit name escaping is implemented in TypeScript and checked against
  `systemd-escape` in the integration test, so a mount point outside
  `/mnt/ohr` works too.
- If a later version needs arrays in the initramfs, for example to boot from
  an Open HR volume, that is a new decision.
