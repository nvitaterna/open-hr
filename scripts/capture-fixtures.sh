#!/usr/bin/env bash
# Captures the command output Open HR parses, for use as test fixtures.
# Read-only: it never writes to a drive. Run as root so mdadm and smartctl work.
#
# Usage: sudo scripts/capture-fixtures.sh [output-directory]

set -euo pipefail

out="${1:-ohr-fixtures-$(hostname)-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$out"

run() {
  local file="$1"
  shift
  if "$@" >"$out/$file" 2>"$out/$file.stderr"; then
    rm -f "$out/$file.stderr"
  else
    echo "warning: '$*' failed, see $out/$file.stderr" >&2
  fi
}

run lsblk.json lsblk --json --bytes --output \
  NAME,PATH,PKNAME,TYPE,SIZE,MODEL,SERIAL,WWN,TRAN,ROTA,RM,RO,FSTYPE,UUID,PARTUUID,PARTLABEL,PARTTYPE,PARTN,MOUNTPOINTS
run findmnt.json findmnt --json --bytes --output TARGET,SOURCE,FSTYPE,OPTIONS,SIZE,USED,AVAIL
run blkid.txt blkid -o export
run pvs.json pvs --reportformat json --units b --nosuffix --options pv_name,vg_name,pv_uuid,pv_size,pv_free
run vgs.json vgs --reportformat json --units b --nosuffix --options vg_name,vg_uuid,vg_size,vg_free,pv_count,lv_count
run lvs.json lvs --reportformat json --units b --nosuffix --options lv_name,vg_name,lv_uuid,lv_size,lv_path,lv_attr,lv_layout

if [[ -r /proc/mdstat ]]; then
  cp /proc/mdstat "$out/mdstat.txt"
fi
for md in /dev/md[0-9]*; do
  [[ -b "$md" ]] || continue
  run "mdadm-detail-$(basename "$md").txt" mdadm --detail --export "$md"
done

# smartctl's exit status is a bit mask. Only bits 0 and 1 mean the output is
# unusable; the others report drive conditions, which the fixtures should keep.
smart() {
  local name="$1" status=0
  smartctl --json --all "/dev/$name" >"$out/smartctl-$name.json" 2>"$out/smartctl-$name.json.stderr" || status=$?
  if (( status & 3 )); then
    echo "warning: smartctl failed on /dev/$name (exit $status), see $out/smartctl-$name.json.stderr" >&2
  else
    rm -f "$out/smartctl-$name.json.stderr"
  fi
}

while read -r name type; do
  [[ "$type" == "disk" ]] || continue
  smart "$name"
done < <(lsblk --nodeps --noheadings --output NAME,TYPE)

{
  echo "captured: $(date --iso-8601=seconds)"
  echo "kernel: $(uname -r)"
  grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release || true
  lsblk --version
  mdadm --version 2>&1 || true
  lvm version 2>/dev/null | head -n 1 || true
  smartctl --version 2>/dev/null | head -n 1 || true
} >"$out/versions.txt"

echo "Saved to $out. Review for serial numbers and hostnames before sharing."
