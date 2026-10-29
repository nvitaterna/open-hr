import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient } from '@ohr/rpc/client';
import type { RpcEvent } from '@ohr/rpc/contract';

import type { CommandResult } from '../command-runner.ts';
import {
  exampleShr1Answers,
  exampleShr1Files,
  fakeRunner,
  fixture,
  ok,
} from '../fake-system-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { type Daemon, startDaemon } from './daemon.ts';

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

const UNKNOWN_JOB = '00000000-0000-4000-8000-000000000009';

let directory: string;
let socketPath: string;
let answers: Map<string, CommandResult>;
let daemon: Daemon;
let logged: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ohr-daemon-'));
  socketPath = join(directory, 'run', 'core.sock');
  answers = exampleShr1Answers();
  logged = [];
  daemon = await startDaemon({
    socketPath,
    databasePath: ':memory:',
    socketGroup: null,
    run: fakeRunner(answers).run,
    readFile: exampleShr1Files(),
    log: (line) => logged.push(line),
  });
});

afterEach(async () => {
  await daemon.close();
  await rm(directory, { recursive: true, force: true });
});

describe('ohr-core daemon', () => {
  it('serves the system snapshot, valid against the contract', async () => {
    const expected = await readSystemState({
      run: fakeRunner(exampleShr1Answers()).run,
      readFile: exampleShr1Files(),
      includeSmart: false,
    });
    const rpc = await RpcClient.connect(socketPath);
    const state = await rpc.call('system.state', {});
    expect(state.snapshot).toEqual(expected);
    expect(state.stateHash).toMatch(HEX_SHA256);
    await rpc.close();
  });

  it('lists jobs and answers not-found for an unknown one', async () => {
    const rpc = await RpcClient.connect(socketPath);
    await expect(rpc.call('jobs.list', {})).resolves.toEqual({ jobs: [] });
    await expect(rpc.call('jobs.get', { id: UNKNOWN_JOB })).rejects.toMatchObject({
      code: 'not-found',
    });
    await rpc.close();
  });

  it('tells subscribers when the snapshot changes', async () => {
    const rpc = await RpcClient.connect(socketPath);
    const seen: RpcEvent[] = [];
    await rpc.subscribe((event) => seen.push(event));
    await daemon.state.refresh();
    answers.set('findmnt', ok(fixture('virtio-vm/findmnt.json')));
    const changed = await daemon.state.refresh();
    await rpc.call('jobs.list', {});
    expect(seen).toEqual([
      {
        event: 'state.changed',
        data: { readAt: changed.readAt, stateHash: changed.stateHash },
      },
    ]);
    await rpc.close();
  });

  it('makes the socket 0660 and removes it on close', async () => {
    const info = await stat(socketPath);
    expect(info.isSocket()).toBe(true);
    expect(info.mode % 0o1000).toBe(0o660);
    await daemon.close();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    // afterEach closes again; make that a no-op by starting a fresh daemon.
    daemon = await startDaemon({
      socketPath,
      databasePath: ':memory:',
      socketGroup: null,
      run: fakeRunner(exampleShr1Answers()).run,
      readFile: exampleShr1Files(),
      log: () => undefined,
    });
  });

  it('refuses to start a second daemon on the same socket', async () => {
    await expect(
      startDaemon({
        socketPath,
        databasePath: ':memory:',
        socketGroup: null,
        run: fakeRunner(exampleShr1Answers()).run,
        readFile: exampleShr1Files(),
        log: () => undefined,
      }),
    ).rejects.toThrow('already listening');
  });

  it('warns when the socket group does not exist', async () => {
    const other = await startDaemon({
      socketPath: join(directory, 'other.sock'),
      databasePath: ':memory:',
      socketGroup: 'no-such-group',
      run: fakeRunner(exampleShr1Answers()).run,
      readFile: exampleShr1Files(),
      log: (line) => logged.push(line),
    });
    expect(logged.join('\n')).toContain('Group no-such-group does not exist');
    await other.close();
  });
});
