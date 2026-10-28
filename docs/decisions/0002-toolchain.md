# 0002. Toolchain and repository conventions

- Status: Accepted
- Date: 2026-10-28

## Context

Milestone M0 sets up the repository. The maintainer asked for the latest tool
versions, Turborepo, strict linting with no ambiguity, import ordering like
eslint-plugin-import-x, and no barrel files.

## Decision

**Versions.** Node.js 26, the current LTS, pinned in `.nvmrc`. pnpm 12, pinned
through `packageManager`. TypeScript 7, Vitest 5, Biome 2, Turborepo 2. Shared
tool versions live once in the pnpm catalog in `pnpm-workspace.yaml`, and
packages refer to them as `catalog:`.

**Task running.** Turborepo runs `build`, `typecheck`, `test`, and
`test:coverage` in every package, in dependency order, with caching. Each
package compiles with `tsc` to `dist`. Lint runs once from the root because
Biome is fast enough to check the whole repository.

**TypeScript.** Strict mode plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, and `verbatimModuleSyntax`. Relative imports
name the real `.ts` file, and `rewriteRelativeImportExtensions` turns them into
`.js` in the build. Test files are typechecked but never built.

**Linting.** Biome's `all` preset, which enables every stable rule, and
warnings fail the check. The only exceptions:

| Rule                  | Off for              | Why                                                                                                                                                     |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noNodejsModules`     | `core`, `web`, `cli` | They run on the server. The rule stays on for `shared` and `ui`, which must work in the browser.                                                        |
| `noMagicNumbers`      | test files           | Tests compare against literal expected values.                                                                                                          |
| `noUnresolvedImports` | everywhere           | It resolves `@ohr/*` packages through their build output, so lint would fail before a build. `pnpm typecheck` already fails on every unresolved import. |

**Import order.** Biome's import organizer sorts imports into groups separated
by blank lines, alphabetical within each group, and the check fails on
unsorted imports:

1. Node built-ins (`node:*`)
2. Third-party packages
3. Our packages (`@ohr/*`)
4. Relative paths

Import cycles, unused imports, and imports below other code are errors.

**No barrel files, ever.** No `index.ts` that re-exports other modules.
Packages expose each module by subpath through `"exports": { "./*": ... }`,
so code imports `@ohr/shared/constants`, never `@ohr/shared`. Biome's
`noBarrelFile` and `noReExportAll` rules enforce this with no exceptions.

## Consequences

Staying on the latest versions means occasional breaking upgrades, which
Dependabot surfaces weekly. The `all` preset will flag new rules on Biome
upgrades; each one is either fixed in code or added to the exception table
above with a reason. Subpath imports are slightly longer but make every
import point at the file that defines it.
