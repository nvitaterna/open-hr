#!/usr/bin/env node
import process from 'node:process';

import { run } from './run.ts';

process.exitCode = run(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
