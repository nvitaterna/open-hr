#!/usr/bin/env bash
# `pnpm dev` (decision 0010): ohr-core under sudo, ohr-web as you, and Vite
# with hot reload. Everything they keep goes in .dev/, never in /run/ohr or
# /var/lib/ohr, so an installed Open HR is not touched. Ctrl-C stops all three.
#
#   pnpm dev                 # then open http://localhost:5173
#   pnpm dev --host          # also listen on the network, to browse from another computer
#   OHR_DEV_LOOP=1 pnpm dev  # also show loop devices, for testing on loop files
#
# Options after `pnpm dev` go to Vite.
#
# ohr-core can do anything a pool needs, so run this only on a test machine.
set -euo pipefail
# sudo may keep a login PATH without the sbin directories mdadm and lvm live in.
export PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"

REPO=$(cd "$(dirname "$0")/.." && pwd)
DEV="$REPO/.dev"
SOCKET="$DEV/core.sock"
WEB_PORT=7700
PIDS=()

stop() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # ohr-core runs as root.
  sudo pkill -f "daemon/main.js --socket $SOCKET" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap stop EXIT INT TERM

mkdir -p "$DEV/web"
cd "$REPO"
echo "Building the server packages..."
pnpm --filter @ohr/shared --filter @ohr/rpc --filter @ohr/core --filter @ohr/web build >/dev/null

allow_loop=()
if [ "${OHR_DEV_LOOP:-}" = 1 ]; then
  allow_loop=(--allow-loop)
fi
# Ask for the password now, if sudo needs one, rather than in the middle of the output.
sudo true
sudo node packages/core/dist/daemon/main.js --socket "$SOCKET" --database "$DEV/ohr.db" \
  --group "$(id -gn)" "${allow_loop[@]}" >>"$DEV/core.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 50); do
  [ -S "$SOCKET" ] && break
  sleep 0.2
done
[ -S "$SOCKET" ] || { echo "ohr-core did not start; see $DEV/core.log" >&2; exit 1; }

if [ ! -f "$DEV/web/web.db" ] && [ ! -f "$DEV/web/setup-token" ]; then
  node packages/web/dist/main.js setup-token --data "$DEV/web"
fi
node packages/web/dist/main.js --insecure-http --port "$WEB_PORT" --data "$DEV/web" \
  --socket "$SOCKET" >>"$DEV/web.log" 2>&1 &
PIDS+=("$!")

echo "ohr-core and ohr-web logs: $DEV/core.log, $DEV/web.log"
echo "A forgotten setup token is in $DEV/web/setup-token."
OHR_WEB_URL="http://127.0.0.1:$WEB_PORT" pnpm --filter @ohr/ui dev "$@"
