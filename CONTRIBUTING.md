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

You need Node.js 26 (see `.nvmrc`). pnpm 12 and Turborepo come through Corepack and the workspace:

```sh
corepack enable
pnpm install
pnpm check      # lint, typecheck, and unit tests
pnpm build
```

Storage work needs a Linux virtual machine, never your own drives. The plan's
section 9 describes the recommended Debian VM with extra virtual disks.

## Useful scripts

| Script               | What it does                                               |
| -------------------- | ---------------------------------------------------------- |
| `pnpm lint`          | Biome lint, format, and import order check. Warnings fail. |
| `pnpm format`        | Apply Biome fixes, formatting, and import sorting          |
| `pnpm typecheck`     | TypeScript over every package, tests included              |
| `pnpm test`          | Unit tests with Vitest in every package                    |
| `pnpm test:coverage` | Unit tests with coverage reports                           |
| `pnpm build`         | Compile every package to `dist`                            |
| `pnpm check`         | Lint, typecheck, and test in one go                        |

Package tasks run through Turborepo, which caches results. Run one package's
tasks with a filter, for example `pnpm turbo run test --filter=@ohr/shared`.

## Code conventions

These are enforced by Biome and TypeScript, so CI fails if they are broken.
The reasoning is in [decision 0002](docs/decisions/0002-toolchain.md).

- **No barrel files.** Never write an `index.ts` that re-exports other modules.
  Import from the module that defines the thing, for example
  `import { MIN_DRIVES } from '@ohr/shared/constants'`.
- **Relative imports use the `.ts` extension**, for example `./run.ts`.
- **Imports are grouped and sorted**: Node built-ins, third-party packages,
  `@ohr/*` packages, then relative paths, with a blank line between groups.
  `pnpm format` does this for you.
- **No magic numbers** outside tests. Give every number a named constant.
- **No Node built-ins in `shared` or `ui`**, because they run in the browser.
- **Exports go last** in a file, after private helpers and constants.
- **No `console`.** Write to `process.stdout` and `process.stderr`, or use the
  logger once it exists.

## Tests and fixtures

- Parsers are tested against sample command output in
  `packages/shared/fixtures`. The README there says which samples are real
  and which are synthesized.
- To capture real output from a test machine, run
  `sudo scripts/capture-fixtures.sh`. It only reads. Review the files for
  serial numbers and hostnames before committing them.
- Code shared between tests goes in a file ending in `-test-helpers.ts`. It
  is never built into `dist`.
- Tests never run commands that change a system. Code that does goes through
  the command runner in `core`, which tests replace with a fake.

## Repository layout

```
packages/shared   schemas, types, layout planner, parsers (pure, browser-safe)
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
