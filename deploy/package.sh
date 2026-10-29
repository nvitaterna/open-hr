#!/usr/bin/env bash
# Builds open-hr_<version>_amd64.deb (decision 0009):
#   1. builds the workspace and bundles core, web, and the CLI with esbuild;
#   2. downloads the Node binary named in .nvmrc and checks its SHA-256
#      against the Node project's SHASUMS256.txt;
#   3. stages /opt/ohr and runs nfpm.
#
#   pnpm package                        # version from package.json
#   OHR_VERSION=0.1.0-rc.1 pnpm package
#
# Needs curl, tar, and nfpm on PATH (https://nfpm.goreleaser.com).
set -euo pipefail
# Files in the package are writable by root only, whatever this machine's umask is.
umask 022

REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT="$REPO/deploy/out"
STAGE="$OUT/stage/opt/ohr"
CACHE="$OUT/cache"
NODE_VERSION=$(tr -d '[:space:]' <"$REPO/.nvmrc")
NODE_DIST="node-v$NODE_VERSION-linux-x64"
NODE_URL="https://nodejs.org/dist/v$NODE_VERSION"

cd "$REPO"
OHR_VERSION=${OHR_VERSION:-$(node -p 'require("./package.json").version')}
export OHR_VERSION

command -v nfpm >/dev/null || { echo "nfpm is not on PATH: https://nfpm.goreleaser.com/install/" >&2; exit 1; }

echo "Building and bundling..."
pnpm build >/dev/null
rm -rf "$OUT/stage"
node deploy/bundle.ts "$STAGE/lib"
# Node runs the bundles; they do not need to be executable themselves.
chmod 0644 "$STAGE"/lib/*

echo "Fetching Node $NODE_VERSION..."
mkdir -p "$CACHE"
archive="$NODE_DIST.tar.xz"
if [ ! -f "$CACHE/$archive" ]; then
  curl -fsSL -o "$CACHE/$archive.part" "$NODE_URL/$archive"
  mv "$CACHE/$archive.part" "$CACHE/$archive"
fi
curl -fsSL -o "$CACHE/SHASUMS256-$NODE_VERSION.txt" "$NODE_URL/SHASUMS256.txt"
(cd "$CACHE" && grep " $archive\$" "SHASUMS256-$NODE_VERSION.txt" | sha256sum --check --quiet -)

mkdir -p "$STAGE/node/bin"
tar -xJf "$CACHE/$archive" -C "$OUT" "$NODE_DIST/bin/node" "$NODE_DIST/LICENSE"
mv "$OUT/$NODE_DIST/bin/node" "$STAGE/node/bin/node"
mv "$OUT/$NODE_DIST/LICENSE" "$STAGE/node/LICENSE"
rm -rf "${OUT:?}/$NODE_DIST"

cp -r packages/ui/dist "$STAGE/ui"

echo "Packaging open-hr $OHR_VERSION..."
nfpm package --config deploy/debian/nfpm.yaml --packager deb --target "$OUT/"
ls -l "$OUT"/open-hr_*.deb
