import { parseArgs } from 'node:util';

import type { JobRecord } from '@ohr/shared/jobs';

import { EXIT_OK, type Io, UsageError } from '../io.ts';
import { followJob, printJob } from '../jobs.ts';
import { formatTable } from '../table.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** What a job makes, for messages: "Pool p1" or "Volume data". */
function subject(job: JobRecord): string {
  if (job.kind === 'volume-create') {
    const input = job.input as { name?: unknown };
    return `Volume ${String(input.name)}`;
  }
  return `Pool ${job.poolId}`;
}

function jobId(positionals: readonly string[]): string {
  const [id, ...extra] = positionals;
  if (id === undefined || extra.length > 0 || !UUID_PATTERN.test(id)) {
    throw new UsageError('Give one job id, as ohr job list shows it.');
  }
  return id;
}

async function listJobs(args: readonly string[], io: Io): Promise<number> {
  parseArgs({ args: [...args], options: {}, strict: true, allowPositionals: false });
  const { jobs } = await (await io.core()).call('jobs.list', {});
  if (jobs.length === 0) {
    io.stdout('No jobs yet.');
    return EXIT_OK;
  }
  const rows = formatTable(
    ['id', 'kind', 'pool', 'status', 'created'],
    jobs.map((job) => [job.id, job.kind, job.poolId, job.status, job.createdAt]),
  );
  for (const row of rows) {
    io.stdout(row);
  }
  return EXIT_OK;
}

async function showJob(args: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { follow: { type: 'boolean', default: false } },
    strict: true,
    allowPositionals: true,
  });
  const id = jobId(positionals);
  const core = await io.core();
  const { job, log } = await core.call('jobs.get', { id });
  printJob(io, job, log);
  if (!values.follow || job.status === 'done' || job.status === 'failed') {
    return EXIT_OK;
  }
  io.stdout('');
  io.stdout(`Following job ${id}. Ctrl-C stops following; the job keeps running.`);
  return followJob(io, {
    subject: subject(job),
    start: async (client) => (await client.call('jobs.get', { id })).job,
  });
}

async function retryJob(args: readonly string[], io: Io): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    strict: true,
    allowPositionals: true,
  });
  const id = jobId(positionals);
  const { job } = await (await io.core()).call('jobs.get', { id });
  io.stdout(`Retrying job ${id} from its failed step.`);
  return followJob(io, {
    subject: subject(job),
    start: async (client) => (await client.call('jobs.retry', { id })).job,
  });
}

export const JOB_USAGE = `Usage: ohr job list
       ohr job show [--follow] <id>
       ohr job retry <id>

Jobs are the structural changes ohr-core runs, such as creating a pool.

Commands:
  list     Every job, newest first.
  show     One job's steps, their status, and its log. --follow prints its
           progress until it finishes; Ctrl-C stops following, not the job.
  retry    Runs a failed job again from the step that failed. Steps whose
           work is already there are skipped.`;

export function jobCommand(args: readonly string[], io: Io): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'list') {
    return listJobs(rest, io);
  }
  if (subcommand === 'show') {
    return showJob(rest, io);
  }
  if (subcommand === 'retry') {
    return retryJob(rest, io);
  }
  return Promise.reject(new UsageError(`Unknown job command: ${subcommand ?? '(none)'}`));
}
