# 0001. Planning decisions

- Status: Accepted
- Date: 2026-10-28

## Context

The project scope was agreed in a planning conversation and written up in
[docs/PLAN.md](../PLAN.md). This record captures the outcomes in one place.

## Decision

- Userspace tool that reproduces the Synology Hybrid RAID layout on stock
  Linux with GPT, mdadm, and LVM. No kernel code. No compatibility with real
  Synology pools.
- SHR-1 and SHR-2. Minimum two drives for SHR-1 and four for SHR-2.
- Online expansion by adding drives and by replacing drives with larger ones.
- Hot spares, scheduled scrubs, rebuild monitoring.
- btrfs or ext4 per volume. Snapshots on btrfs. LUKS encryption. LVM SSD cache.
- Debian and Proxmox VE only. Data drives only. Unraid is out of scope.
- Web UI served from the machine, plus a CLI. No Electron.
- Node.js and TypeScript for everything, React for the UI.
- Alerts through one generic webhook. No email in version 1.
- No telemetry in version 1.
- Public name "Open Hybrid RAID", short form `ohr`, repository `open-hr`.
- Web UI on port 7700. Volumes mounted under `/mnt/ohr`.
- Documentation and apt repository on GitHub Pages.
- MIT licence. No dates on the roadmap for now.

## Consequences

The project is one language end to end, which suits a single developer. Running
Node as root is the main security cost, handled by splitting a small root
daemon from an unprivileged web server.
