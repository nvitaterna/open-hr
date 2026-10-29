#!/usr/bin/env bash
# Installs nfpm, the .deb builder, into /usr/local/bin after checking its
# checksum. Used by the CI package job and the release workflow.
set -euo pipefail

NFPM_VERSION=${NFPM_VERSION:-2.48.0}
file="nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz"
base="https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VERSION}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cd "$work"
curl -fsSLO "$base/$file"
curl -fsSL -o checksums.txt "$base/checksums.txt"
grep " $file\$" checksums.txt | sha256sum --check -
sudo tar -xzf "$file" -C /usr/local/bin nfpm
nfpm --version | grep -i '^GitVersion'
