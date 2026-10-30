#!/usr/bin/env bash
# The M2 acceptance check: a pool created with the ohr CLI survives a reboot.
# Run as root on a disposable test VM, never on a machine with real data.
#
#   sudo scripts/reboot-check.sh setup     # loop files, and a unit that attaches them at boot
#   sudo scripts/reboot-check.sh create    # ohr pool create, ohr volume create, write a test file
#   sudo systemctl reboot
#   sudo scripts/reboot-check.sh verify    # arrays, volume group, mount, unit, and file are back
#   sudo scripts/reboot-check.sh cleanup   # remove everything this script made
#
# The M4 reshape case (decision 0011) follows `verify` before `cleanup`:
#
#   sudo scripts/reboot-check.sh add             # ohr pool add a fourth drive, stop once md reshapes
#   sudo systemctl reboot                        # within a few minutes, while the reshape runs
#   sudo scripts/reboot-check.sh verify-reshape  # the pool assembles and the job resumes and finishes
#
# Loop devices do not survive a reboot by themselves, so `setup` installs
# ohr-reboot-check-loops.service to attach them early in boot. From there on
# udev assembles the arrays, LVM activates the volume group, and the mount
# unit ohr wrote mounts the volume, exactly as on real drives.
set -euo pipefail
# sudo may keep a login PATH without the sbin directories that losetup and mdadm live in.
export PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"

DIR=/var/lib/ohr-reboot-check
LOOP_UNIT=ohr-reboot-check-loops.service
POOL=rb
VOLUME=rbdata
MOUNT=/mnt/ohr/$VOLUME
MOUNT_UNIT=mnt-ohr-$VOLUME.mount
# The sparse files fill up as md resyncs and reshapes, so the filesystem
# holding them needs this much free space: about 10 GiB in all.
SIZES_MIB=(1536 2816 2816)
ADD_MIB=2816
REPO=$(cd "$(dirname "$0")/.." && pwd)
SOCKET=$DIR/core.sock
OHR=(node "$REPO/packages/cli/dist/bin.js" --socket "$SOCKET")
FAILED=0
CORE_PID=
JOB_FILE=$DIR/expand-job
# KiB/s. Slow enough that the reshape is still running when the machine reboots.
SLOW_RESHAPE=5000

# A private ohr-core on its own socket and database, so an installed one is never touched.
start_core() {
  node "$REPO/packages/core/dist/daemon/main.js" --socket "$SOCKET" --database "$DIR/ohr.db" \
    --group "" --allow-loop >>"$DIR/core.log" 2>&1 &
  CORE_PID=$!
  for _ in $(seq 50); do
    [ -S "$SOCKET" ] && return 0
    sleep 0.2
  done
  echo "ohr-core did not start; see $DIR/core.log" >&2
  exit 1
}

stop_core() {
  if [ -n "$CORE_PID" ]; then
    kill "$CORE_PID" 2>/dev/null || true
    wait "$CORE_PID" 2>/dev/null || true
    CORE_PID=
  fi
}
trap stop_core EXIT

loops() {
  for file in "$DIR"/drive*.img; do
    losetup --noheadings --output NAME --associated "$file"
  done
}

add_loop() {
  losetup --noheadings --output NAME --associated "$DIR/add0.img"
}

# The md sysfs directory of the pool's array for a tier.
md_sysfs() {
  echo "/sys/block/$(basename "$(realpath "/dev/md/ohr_${POOL}_t$1")")/md"
}

job_done() {
  "${OHR[@]}" job list | awk -v id="$1" '$1 == id { print $4 }' | grep -qx done
}

tier_is() {
  local detail
  detail=$(mdadm --detail --export "/dev/md/ohr_${POOL}_t$1")
  grep -qx "MD_LEVEL=$2" <<<"$detail" && grep -qx "MD_DEVICES=$3" <<<"$detail"
}

check() {
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS  $what"
  else
    echo "FAIL  $what"
    FAILED=1
  fi
}

setup() {
  mkdir -p "$DIR"
  local needed=$ADD_MIB size available
  for size in "${SIZES_MIB[@]}"; do
    needed=$((needed + size))
  done
  available=$(($(df --output=avail --block-size=1M "$DIR" | tail -n 1)))
  if [ "$available" -lt "$needed" ]; then
    # A full filesystem fails the loop devices' writes, and md then fails their members.
    echo "$DIR needs $needed MiB free for the loop files, and has $available MiB." >&2
    rmdir "$DIR" 2>/dev/null || true
    exit 1
  fi
  for index in "${!SIZES_MIB[@]}"; do
    truncate --size "${SIZES_MIB[$index]}M" "$DIR/drive$index.img"
  done
  truncate --size "${ADD_MIB}M" "$DIR/add0.img"
  cat >"/etc/systemd/system/$LOOP_UNIT" <<UNIT
[Unit]
Description=Attach the Open HR reboot-check loop devices
DefaultDependencies=no
RequiresMountsFor=$DIR
After=systemd-udevd.service
Before=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for file in $DIR/*.img; do losetup --find --partscan "\$file"; done'

[Install]
WantedBy=local-fs.target
UNIT
  systemctl daemon-reload
  systemctl enable "$LOOP_UNIT"
  # restart, not --now: a oneshot left active by an earlier run would not run again.
  systemctl restart "$LOOP_UNIT"
  udevadm settle
  echo "Attached: $(loops | tr '\n' ' ')"
}

create() {
  mapfile -t devices < <(loops)
  start_core
  printf '%s\n' "$POOL" | "${OHR[@]}" pool create --id "$POOL" --redundancy shr1 "${devices[@]}"
  printf '%s\n' "$VOLUME" | "${OHR[@]}" volume create --pool "$POOL" --name "$VOLUME" --fs btrfs
  stop_core
  head --bytes 64M /dev/urandom >"$MOUNT/test.bin"
  sync
  (cd "$MOUNT" && sha256sum test.bin) >"$DIR/test.sha256"
  echo "Wrote $MOUNT/test.bin. Reboot, then run: $0 verify"
}

verify() {
  check "loop devices attached at boot" test "$(loops | wc -l)" -eq "${#SIZES_MIB[@]}"
  check "array ohr_${POOL}_t1 assembled" mdadm --detail "/dev/md/ohr_${POOL}_t1"
  check "array ohr_${POOL}_t2 assembled" mdadm --detail "/dev/md/ohr_${POOL}_t2"
  check "volume ohr-$POOL/$VOLUME active" test -b "/dev/ohr-$POOL/$VOLUME"
  check "mount unit $MOUNT_UNIT active" systemctl is-active --quiet "$MOUNT_UNIT"
  check "$MOUNT is the @data subvolume" sh -c "findmnt --noheadings --output OPTIONS $MOUNT | grep -q 'subvol=/@data'"
  check "test file intact" sh -c "cd $MOUNT && sha256sum --check --quiet $DIR/test.sha256"
  echo
  start_core
  "${OHR[@]}" status
  stop_core
  return "$FAILED"
}

# Starts adding the spare drive and returns once md reshapes, leaving the job to finish after a reboot.
add() {
  local device cli action tier
  device=$(add_loop)
  # The new pool resyncs first, and ohr refuses to change a busy array.
  for tier in 1 2; do
    mdadm --wait "/dev/md/ohr_${POOL}_t$tier" || true
  done
  start_core
  "${OHR[@]}" pool add "$POOL" --yes "$device" >"$DIR/add.log" 2>&1 &
  cli=$!
  for _ in $(seq 600); do
    for tier in 1 2; do
      action=$(cat "$(md_sysfs "$tier")/sync_action" 2>/dev/null || true)
      if [ "$action" = reshape ]; then
        echo "$SLOW_RESHAPE" >"$(md_sysfs "$tier")/sync_speed_max"
        break 2
      fi
    done
    if ! kill -0 "$cli" 2>/dev/null; then
      cat "$DIR/add.log" >&2
      echo "ohr pool add ended before any reshape started." >&2
      exit 1
    fi
    sleep 0.5
  done
  if [ "$action" != reshape ]; then
    echo "No reshape started; see $DIR/add.log" >&2
    exit 1
  fi
  # Ctrl-C stops the CLI following the job; the job carries on in ohr-core until it stops.
  kill -INT "$cli"
  wait "$cli" || true
  "${OHR[@]}" job list | awk '$2 == "pool-expand" { print $1; exit }' >"$JOB_FILE"
  test -s "$JOB_FILE"
  stop_core
  cat /proc/mdstat
  echo "Tier $tier is reshaping, slowed to $SLOW_RESHAPE KiB/s. Reboot now, then run: $0 verify-reshape"
}

# After the reboot: the grown pool assembles, ohr-core resumes the job, and it finishes.
verify_reshape() {
  local job tier
  job=$(cat "$JOB_FILE")
  check "loop devices attached at boot" test "$(loops | wc -l)" -eq "${#SIZES_MIB[@]}"
  check "added drive attached at boot" test -n "$(add_loop)"
  for tier in 1 2; do
    check "array ohr_${POOL}_t$tier assembled" mdadm --detail "/dev/md/ohr_${POOL}_t$tier"
    echo "      ohr_${POOL}_t$tier: $(cat "$(md_sysfs "$tier")/array_state"), $(cat "$(md_sysfs "$tier")/sync_action")"
  done
  check "mount unit $MOUNT_UNIT active" systemctl is-active --quiet "$MOUNT_UNIT"
  start_core
  # ohr-core resumed the job on start; follow it to the end.
  "${OHR[@]}" job show --follow "$job" | tail -n 20
  check "job $job done" job_done "$job"
  check "tier 1 is RAID5 on 4 drives" tier_is 1 raid5 4
  check "tier 2 is RAID5 on 3 drives" tier_is 2 raid5 3
  check "test file intact" sh -c "cd $MOUNT && sha256sum --check --quiet $DIR/test.sha256"
  echo
  "${OHR[@]}" status
  stop_core
  return "$FAILED"
}

cleanup() {
  systemctl disable --now "$MOUNT_UNIT" 2>/dev/null || true
  rm -f "/etc/systemd/system/$MOUNT_UNIT"
  systemctl daemon-reload
  rmdir "$MOUNT" 2>/dev/null || true
  vgremove --force "ohr-$POOL" 2>/dev/null || true
  for tier in 1 2; do
    mdadm --stop "/dev/md/ohr_${POOL}_t$tier" 2>/dev/null || true
  done
  rm -f "/etc/mdadm/mdadm.conf.d/ohr-$POOL.conf"
  if [ -d "$DIR" ]; then
    for file in "$DIR"/*.img; do
      losetup --noheadings --output NAME --associated "$file"
    done | xargs --no-run-if-empty losetup --detach
  fi
  systemctl disable --now "$LOOP_UNIT" 2>/dev/null || true
  rm -f "/etc/systemd/system/$LOOP_UNIT"
  systemctl daemon-reload
  rm -rf "$DIR"
  echo "Removed the reboot-check pool, units, and files."
}

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root." >&2
  exit 1
fi
case "${1:-}" in
  setup | create | verify | add | cleanup) "$1" ;;
  verify-reshape) verify_reshape ;;
  *)
    echo "Usage: $0 setup|create|verify|add|verify-reshape|cleanup" >&2
    exit 2
    ;;
esac
