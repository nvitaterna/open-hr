# Open Hybrid RAID (ohr)

Synology Hybrid RAID for any Linux box. Mix drive sizes, keep the capacity,
grow over time. Built on standard `mdadm` and LVM, managed from a web UI and CLI.

> **Status: early development.** Nothing here is usable yet. Do not point it at
> drives that hold data you care about.

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

## Try it

There is no package yet, so run it from a build. Open HR is pre-release: do
not trust it with the only copy of your data, and try it on a test machine or
VM.

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
```

## Licence

[MIT](LICENSE)
