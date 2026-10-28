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

## Development

```sh
corepack enable
pnpm install
pnpm check
```

## Licence

[MIT](LICENSE)
