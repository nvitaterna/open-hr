#!/usr/bin/env bash
# Runs lsblk with exactly the columns core asks for (LSBLK_COLUMNS in
# packages/shared/src/parsers/lsblk.ts). lsblk refuses a column it does not
# know, so on a util-linux too old for one of them this fails. CI runs it on
# every Debian release Open HR supports.
set -euo pipefail

SOURCE=packages/shared/src/parsers/lsblk.ts
columns=$(sed -n '/^export const LSBLK_COLUMNS = \[/,/^\] as const;/p' "$SOURCE" |
  grep -oE "'[A-Z:-]+'" | tr -d "'" | paste -sd, -)
if [ -z "$columns" ]; then
  echo "::error file=$SOURCE::Could not read LSBLK_COLUMNS"
  exit 1
fi
lsblk --version
if ! lsblk --json --bytes --output "$columns" >/dev/null; then
  echo "::error file=$SOURCE::lsblk $(lsblk --version | grep -oE '[0-9.]+$') rejects the columns $columns"
  exit 1
fi
echo "lsblk accepts $columns"
