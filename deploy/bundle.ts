/**
 * Bundles ohr-core, ohr-web, and the CLI into one ES module each
 * (decision 0009). Third-party code is inlined; only Node's built-ins stay
 * outside. Run after `pnpm build`, which the bundles read the workspace
 * packages from.
 *
 *   node deploy/bundle.ts [outdir]     # default deploy/out/lib
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { build } from 'esbuild';

const REPO = join(import.meta.dirname, '..');
const DEFAULT_OUT = join(REPO, 'deploy', 'out', 'lib');
const BYTES_PER_KIB = 1024;

const ENTRIES = {
  core: 'packages/core/dist/daemon/main.js',
  web: 'packages/web/dist/main.js',
  cli: 'packages/cli/dist/bin.js',
} as const;

/**
 * Some dependencies are CommonJS and call require() for built-ins. An ES
 * module has no require, so each bundle makes one.
 */
const REQUIRE_SHIM = [
  "import { createRequire as __ohrCreateRequire } from 'node:module';",
  'const require = __ohrCreateRequire(import.meta.url);',
].join('\n');

async function bundle(outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const outfile = join(outDir, `${name}.mjs`);
    // Sequential, so a failure names the bundle it came from.
    // biome-ignore lint/performance/noAwaitInLoops: three bundles, one at a time on purpose
    const result = await build({
      entryPoints: [join(REPO, entry)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      banner: { js: REQUIRE_SHIM },
      legalComments: 'linked',
      metafile: true,
      logLevel: 'warning',
    });
    const bytes = Object.values(result.metafile.outputs).reduce(
      (total, output) => total + output.bytes,
      0,
    );
    process.stdout.write(`${name}.mjs: ${Math.round(bytes / BYTES_PER_KIB)} KiB\n`);
  }
}

await bundle(process.argv[2] ?? DEFAULT_OUT);
