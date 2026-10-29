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
SIZES_GIB=(2 4 4)
REPO=$(cd "$(dirname "$0")/.." && pwd)
SOCKET=$DIR/core.sock
OHR=(node "$REPO/packages/cli/dist/bin.js" --socket "$SOCKET")
FAILED=0
CORE_PID=

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
  for index in "${!SIZES_GIB[@]}"; do
    truncate --size "${SIZES_GIB[$index]}G" "$DIR/drive$index.img"
  done
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
ExecStart=/bin/sh -c 'for file in $DIR/drive*.img; do losetup --find --partscan "\$file"; done'

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
  check "loop devices attached at boot" test "$(loops | wc -l)" -eq "${#SIZES_GIB[@]}"
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
    loops | xargs --no-run-if-empty losetup --detach
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
  setup | create | verify | cleanup) "$1" ;;
  *)
    echo "Usage: $0 setup|create|verify|cleanup" >&2
    exit 2
    ;;
esac
