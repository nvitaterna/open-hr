import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyDrivesMachine, runCli } from '../cli-test-helpers.ts';

const JOB_ID = /Job (?<id>[0-9a-f-]{36})\./u;
const CREATE = ['pool', 'create', '--id', 'p2', '--redundancy', 'shr1', '/dev/sdx', '/dev/sdy'];

let directory: string;
let database: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ohr-cli-jobs-'));
  database = join(directory, 'ohr.db');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Creates a pool on the fake machine, whose missing sgdisk fails the first step. Returns the job id. */
async function failedPoolJob(): Promise<{
  id: string;
  stdout: string;
  stderr: string;
  code: number;
}> {
  const result = await runCli(CREATE, emptyDrivesMachine(), new Map(), {
    answer: 'p2',
    database,
  });
  const id = JOB_ID.exec(result.stderr)?.groups?.id;
  if (id === undefined) {
    throw new Error(`no job id in: ${result.stderr}`);
  }
  return { id, ...result };
}

describe('ohr job', () => {
  it('says when there are no jobs', async () => {
    const result = await runCli(['job', 'list'], emptyDrivesMachine(), new Map(), { database });
    expect(result).toMatchObject({ code: 0, stdout: 'No jobs yet.' });
  });

  it('follows a pool job core runs and explains how to retry it after a failure', async () => {
    const { id, code, stdout, stderr } = await failedPoolJob();
    expect(code).toBe(1);
    expect(stdout).toContain('[1/');
    expect(stdout).toContain('partition /dev/sdx: failed');
    expect(stderr).toContain('Pool p2 was not created');
    expect(stderr).toContain(`ohr job retry ${id}`);
  });

  it('lists and shows the job, then retries it from the failed step', async () => {
    const { id } = await failedPoolJob();
    const list = await runCli(['job', 'list'], emptyDrivesMachine(), new Map(), { database });
    expect(list.stdout).toContain(`${id}  pool-create  p2    failed`);
    const show = await runCli(['job', 'show', id], emptyDrivesMachine(), new Map(), { database });
    expect(show.stdout).toContain(`Job ${id}: pool-create on pool p2, failed`);
    expect(show.stdout).toContain('1. partition /dev/sdx: failed');
    expect(show.stdout).toContain('2. partition /dev/sdy: pending');
    const retry = await runCli(['job', 'retry', id], emptyDrivesMachine(), new Map(), {
      database,
    });
    expect(retry.stdout).toContain(`Retrying job ${id} from its failed step.`);
    expect(retry.stdout).toContain('partition /dev/sdx: failed');
    expect(retry.code).toBe(1);
  });

  it('refuses an unknown job and a bad id', async () => {
    const unknown = await runCli(
      ['job', 'show', '00000000-0000-4000-8000-000000000009'],
      emptyDrivesMachine(),
      new Map(),
      { database },
    );
    expect(unknown).toMatchObject({
      code: 1,
      stderr: 'There is no job 00000000-0000-4000-8000-000000000009.',
    });
    expect((await runCli(['job', 'show', 'nope'])).code).toBe(2);
    expect((await runCli(['job', 'explode'])).code).toBe(2);
  });
});
