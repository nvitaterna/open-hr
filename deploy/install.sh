#!/usr/bin/env bash
# Installs or upgrades Open HR from its GitHub releases (decision 0009).
#
#   curl -fsSL https://raw.githubusercontent.com/nvitaterna/open-hr/main/deploy/install.sh | sudo bash
#   curl -fsSL ... | sudo OHR_VERSION=0.1.0 bash      # a given release instead of the newest
#
# Checks for Debian 12 or 13 (Proxmox VE 8 and 9 are Debian underneath) on
# amd64, downloads the .deb and its SHA-256 from the release, checks it, and
# installs it with apt so the dependencies come too. Running it again
# upgrades. Open HR is a pre-release: do not trust it with the only copy of
# your data.
set -euo pipefail

REPO=nvitaterna/open-hr
API="https://api.github.com/repos/$REPO/releases?per_page=20"
DOWNLOADS="https://github.com/$REPO/releases/download"

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "run this as root, for example: curl -fsSL <url> | sudo bash"
fi

if [ ! -r /etc/os-release ]; then
  fail "cannot tell which system this is: /etc/os-release is missing."
fi
# shellcheck source=/dev/null
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  debian:12 | debian:13) ;;
  *) fail "Open HR runs on Debian 12 and 13 and Proxmox VE 8 and 9. This is ${PRETTY_NAME:-an unknown system}." ;;
esac

arch=$(dpkg --print-architecture)
if [ "$arch" != amd64 ]; then
  fail "Open HR is built for amd64 only so far. This machine is $arch."
fi

if ! command -v curl >/dev/null; then
  fail "curl is needed: apt-get install curl"
fi

# The newest release, pre-releases included: every 0.x release is one, and
# GitHub's "latest release" skips them.
version=${OHR_VERSION:-}
if [ -z "$version" ]; then
  releases=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API") ||
    fail "could not ask GitHub for the releases of $REPO."
  version=$(printf '%s\n' "$releases" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | sed -n 1p)
  if [ -z "$version" ]; then
    fail "$REPO has no release yet."
  fi
fi
version=${version#v}

deb="open-hr_${version}_amd64.deb"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# apt reads the file as its own unprivileged user.
chmod 0755 "$work"

echo "Downloading Open HR $version..."
curl -fSL --progress-bar -o "$work/$deb" "$DOWNLOADS/v$version/$deb" ||
  fail "could not download $deb. Is $version a release of $REPO?"
curl -fsSL -o "$work/$deb.sha256" "$DOWNLOADS/v$version/$deb.sha256" ||
  fail "could not download the checksum for $deb."
(cd "$work" && sha256sum --check --quiet "$deb.sha256") ||
  fail "$deb does not match its published SHA-256. Nothing was installed."
chmod 0644 "$work/$deb"

echo "Installing..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install --yes "$work/$deb"
