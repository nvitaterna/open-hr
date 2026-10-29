# 0009. Packaging, install script, and the 0.1 release

- Status: Accepted
- Date: 2026-10-29

## Context

Plan section 7 describes one `.deb` built with nfpm, a bundled Node binary
under `/opt/ohr`, two systemd units, a udev rule, an install script that adds
an apt repository on GitHub Pages, and semantic versions. M3 ships the first
installable pre-release, so the build, the file layout, and the release path
need fixing. The apt repository is more release machinery than a first
pre-release needs.

## Decision

### Build

- Each process is bundled with esbuild into one ES module file:
  `core.mjs`, `web.mjs`, and `cli.mjs`. Third-party code is inlined; only
  `node:` built-ins stay external. The UI is the Vite build output.
- The package bundles the official Node binary for the exact version in
  `.nvmrc`, which CI uses too. `deploy/package.sh` downloads it and checks it
  against the Node project's `SHASUMS256.txt`, fetched over HTTPS. Checking
  that file's GPG signature as well is left for the release automation in M7.
  Only `amd64` in 0.1; `arm64` follows once there is a machine to test it on.
- nfpm builds `open-hr_<version>_amd64.deb` from `deploy/debian/nfpm.yaml`.
  `pnpm package` runs the whole build locally.

### Installed layout

| Path                                    | What                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| `/opt/ohr/node/bin/node`                | bundled Node                                               |
| `/opt/ohr/lib/{core,web,cli}.mjs`       | bundles                                                    |
| `/opt/ohr/ui/`                          | UI build                                                   |
| `/usr/bin/ohr`, `/usr/bin/ohr-web`      | wrappers that run the bundles with the bundled Node        |
| `/usr/lib/systemd/system/ohr-*.service` | `ohr-core` (root) and `ohr-web` (user `ohr`)               |
| `/usr/lib/sysusers.d/open-hr.conf`      | the `ohr` system user and group                            |
| `/usr/lib/tmpfiles.d/open-hr.conf`      | creates `/run/ohr` at boot                                 |
| `/etc/ohr/`                             | configuration and `tls/`                                   |
| `/var/lib/ohr/`                         | core database; `web/` belongs to `ohr`                     |
| `/run/ohr/`                             | the socket's directory, `root:ohr` 0750, from `tmpfiles.d` |
- `ohr-web` has `After=` and `Requires=ohr-core.service` and retries the
  socket with backoff, so a core restart does not leave web broken.
- `ohr-web` runs with `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp`, and write access only to `/var/lib/ohr/web`.
  `ohr-core` needs the devices and `/etc`, so it gets `PrivateTmp` and
  `ProtectHome` only.
- `postinst` creates the `ohr` system user and group with
  `systemd-sysusers`, the certificate, and the setup token (decision 0008),
  enables and starts both services, and prints the setup URL with the first
  IPv4 address. A reinstall or upgrade keeps an existing certificate, token,
  and database. `prerm` stops the services. Removing or purging the
  package never touches pools, mount units, or mdadm files; purge removes
  `/etc/ohr` and `/var/lib/ohr` only.
- Package dependencies: `mdadm`, `lvm2`, `btrfs-progs`, `e2fsprogs`, `gdisk`,
  `util-linux`, `udev`, `openssl`. `cryptsetup` and `smartmontools` are
  recommended, not required, until the features that need them ship.
- No udev rule yet. Core watches `udevadm monitor` itself (decision 0007),
  which needs no file in `/etc` or `/lib/udev`.

### Install script and releases

- `install.sh` checks for Debian 12 or 13 (or Proxmox VE 8 or 9) on `amd64`,
  downloads the `.deb` and its SHA-256 from the newest GitHub release, checks
  it, and installs it with `apt-get install` so apt pulls the dependencies.
  GitHub's "latest release" skips pre-releases, and every 0.x release is one,
  so the script asks the API for the newest release of any kind, and the
  README points at the copy on `main`. `OHR_VERSION` picks a given release.
  The apt repository on GitHub Pages moves to M7 with the rest of the release
  automation.
- CI builds the package on every pull request, installs it on the runner,
  runs `deploy/smoke-test.sh` (services, HTTPS setup page, CLI, owners and
  modes), reinstalls it, removes it, and purges it.
- Pushing a tag `v*` runs a release workflow: the full check and integration
  suites, then the package build, then a GitHub release with the `.deb`, its
  SHA-256, and `install.sh`. Every `0.x` version, and any version with a
  pre-release part such as `v0.1.0-rc.1`, is marked as a pre-release on
  GitHub.
- 0.x release notes and the README carry the plan's warning: do not trust it
  with the only copy of your data.

## Consequences

- One self-contained package with no dependency on the distribution's Node.
  It is about 40 MB larger than it would be with a system Node.
- Without an apt repository, upgrades in 0.x mean running `install.sh` again.
- Bundling with esbuild means the bundles, not `tsc` output, are what users
  run. The package smoke test (install on a clean VM, start both services,
  load the setup page) covers that difference.
