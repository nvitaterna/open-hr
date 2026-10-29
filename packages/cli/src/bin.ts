#!/usr/bin/env node
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import { runCommand } from '@ohr/core/command-runner';
import { readTextFile } from '@ohr/core/file-reader';

import { run } from './run.ts';

// When output is piped into something that stops reading early, such as `head`, exit quietly.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
});

process.exitCode = await run(process.argv.slice(2), {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  run: runCommand,
  readFile: readTextFile,
  confirm: async (question) => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await terminal.question(question);
    } finally {
      terminal.close();
    }
  },
  isRoot: () => process.getuid?.() === 0,
});
