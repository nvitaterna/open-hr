#!/usr/bin/env node
import { run } from './run.js';

process.exitCode = run(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
