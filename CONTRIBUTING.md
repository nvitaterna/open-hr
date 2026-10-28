# Contributing to Open Hybrid RAID

Thanks for your interest. Open HR manages people's drives, so the bar for
correctness is high. Read this whole file before opening a pull request.

## Ground rules

- **Data safety comes first.** Read section 6 of [docs/PLAN.md](docs/PLAN.md),
  the safety model. Pull requests that weaken it are not accepted.
- **Every structural storage change needs an integration test** that runs the
  real tools (`mdadm`, LVM, filesystems) against loop devices. Unit tests with
  mocked commands are not enough on their own.
- **No shell strings.** External commands are always spawned with an argument
  array, never through a shell.
- **Discuss big changes first.** Open an issue or a discussion before starting
  anything that changes the on-disk layout, the API, or the safety model.
  Decisions are recorded in [docs/decisions](docs/decisions).

## Development setup

You need Node.js 26 (see `.nvmrc`) and pnpm 12. Enable pnpm with Corepack:

```sh
corepack enable
pnpm install
pnpm check      # lint, typecheck, and unit tests
pnpm build
```

Storage work needs a Linux virtual machine, never your own drives. The plan's
section 9 describes the recommended Debian VM with extra virtual disks.

## Useful scripts

| Script               | What it does                          |
| -------------------- | ------------------------------------- |
| `pnpm lint`          | Biome lint and format check           |
| `pnpm format`        | Apply Biome fixes and formatting      |
| `pnpm typecheck`     | TypeScript over all sources and tests |
| `pnpm test`          | Unit tests with Vitest                |
| `pnpm test:coverage` | Unit tests with a coverage report     |
| `pnpm build`         | Compile every package to `dist`       |
| `pnpm check`         | Lint, typecheck, and test in one go   |

## Repository layout

```
packages/shared   schemas, types, layout planner, parsers (pure, no side effects)
packages/core     root daemon: job engine, executors, monitor, database
packages/web      web server: API, auth, serves the UI
packages/ui       React UI
packages/cli      the ohr command
docs/             plan, decision records, user docs
```

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org), for example
  `feat(planner): handle three-member SHR-2 tiers` or `fix(core): ...`. The
  changelog is generated from them.
- Keep pull requests focused on one change.
- CI must pass. Run `pnpm check` before pushing.
- Fill in the pull request template, including how you tested.

## Reporting bugs

Use the issue templates. If you lost data or think you could have, use the
**Data loss or corruption** template so it gets looked at first. Report
security problems privately as described in [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contributions are licensed under the MIT
licence in [LICENSE](LICENSE).
