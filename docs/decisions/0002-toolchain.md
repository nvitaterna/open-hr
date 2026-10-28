# 0002. Toolchain and repository layout

- Status: Accepted
- Date: 2026-10-28

## Context

Milestone M0 sets up the repository. The maintainer asked to use the latest
versions of tools.

## Decision

- Node.js 26, the current LTS, pinned in `.nvmrc`.
- pnpm 12 workspaces, pinned through `packageManager` in `package.json`.
- TypeScript 7 in strict mode with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Packages build with project references
  (`tsc -b`). Typechecking runs over sources and tests through
  `tsconfig.check.json`, which maps `@ohr/*` to package sources.
- Biome for linting and formatting.
- Vitest for tests. Tests import sibling packages from source, so nothing
  needs building first.
- Five packages under `packages/`: `shared`, `core`, `web`, `ui`, `cli`.
- GitHub Actions CI runs lint, typecheck, tests with coverage, build, and a
  CLI smoke test. Dependabot keeps npm packages and actions current.

## Consequences

Staying on the latest versions means occasional breaking upgrades, which
Dependabot surfaces weekly. The `ui` package is a plain TypeScript placeholder
until milestone M3 adds React and Vite.
