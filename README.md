# Open Hybrid RAID (ohr)

Synology Hybrid RAID for any Linux box. Mix drive sizes, keep the capacity,
grow over time. Built on standard `mdadm` and LVM, managed from a web UI and CLI.

> **Status: 0.1 pre-release.** You can create a pool and volumes from the
> browser, but growing a pool, replacing drives, and alerts come in later
> releases. Do not trust it with the only copy of your data.

## What it will do

- Pool drives of different sizes with one-drive (SHR-1) or two-drive (SHR-2) redundancy.
- Grow the pool online by adding drives or swapping in bigger ones.
- Hot spares, scheduled scrubs, SMART monitoring, and webhook alerts.
- btrfs or ext4 volumes, with snapshots, encryption, and SSD cache.
- Runs on Debian and Proxmox VE. Pools stay readable with plain Linux tools.

## Documentation

- [Project plan](docs/PLAN.md)
- [Decision records](docs/decisions)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Install

On Debian 12 or 13, or Proxmox VE 8 or 9, on amd64. Try it on a test machine
or VM first.

```sh
curl -fsSL https://raw.githubusercontent.com/nvitaterna/open-hr/main/deploy/install.sh | sudo bash
```

The script downloads the newest release's `.deb` from GitHub, checks its
SHA-256, and installs it with apt. It prints the address of the web interface,
`https://<this machine>:7700`, and a one-time setup token. The certificate is
self-signed, so the browser warns once. Running the script again upgrades.

- `sudo ohr status` shows drives, arrays, and volume groups from the shell.
- `sudo ohr-web setup-token` makes a new token, which is also how a forgotten
  password is reset.
- Removing the package leaves pools and volumes alone: they keep working with
  plain `mdadm` and LVM.

## Run from a build

```sh
pnpm install && pnpm build
alias ohr="node $PWD/packages/cli/dist/bin.js"

ohr plan --redundancy shr1 --sizes 4TB,8TB,8TB      # layout for hypothetical drives, no daemon needed
```

Everything else goes through `ohr-core`, the root daemon. Start it in one
terminal and use the CLI from another:

```sh
sudo node packages/core/dist/daemon/main.js --group "$(id -gn)"
ohr status                                          # drives, arrays, volume groups
ohr status --smart                                  # with SMART health
ohr pool create --id p1 --redundancy shr1 /dev/sdb /dev/sdc
ohr job list
```

## Development

```sh
corepack enable
pnpm install
pnpm check
pnpm dev        # ohr-core under sudo, ohr-web, and the UI with hot reload, on a test machine
pnpm package    # the .deb, in deploy/out (needs nfpm)
```

## Licence

[MIT](LICENSE)
