import { describe, expect, it } from 'vitest';

import { LABEL_PARTITION_BYTES } from '@ohr/shared/constants';
import type { LabelFields } from '@ohr/shared/label-descriptor';

import { type BlockDeviceIo, readLabel, writeLabel } from './label-partition.ts';

const FIELDS: LabelFields = {
  poolId: 'p1',
  poolUuid: '6f1c2b0e-8a3d-4c5e-9f7a-1b2c3d4e5f60',
  driveUuid: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70',
  redundancy: 'shr1',
  writtenAt: '2026-10-29T12:00:00.000Z',
};

/** An in-memory partition that starts full of old data. */
function fakeDevice(): { io: BlockDeviceIo; bytes: Uint8Array } {
  const bytes = new Uint8Array(LABEL_PARTITION_BYTES).fill(0xaa);
  const io: BlockDeviceIo = {
    write: (_path, data) => {
      bytes.set(data);
      return Promise.resolve();
    },
    read: (_path, length) => Promise.resolve(bytes.slice(0, length)),
  };
  return { io, bytes };
}

describe('label partition', () => {
  it('zeros the whole partition and writes the descriptor at the start', async () => {
    const { io, bytes } = fakeDevice();
    await writeLabel(io, '/dev/sda1', FIELDS);
    const text = new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
    expect(JSON.parse(text)).toMatchObject(FIELDS);
    expect(bytes.subarray(text.length).every((byte) => byte === 0)).toBe(true);
  });

  it('reads back what it wrote', async () => {
    const { io } = fakeDevice();
    await writeLabel(io, '/dev/sda1', FIELDS);
    expect(await readLabel(io, '/dev/sda1')).toMatchObject({ kind: 'ok', descriptor: FIELDS });
  });

  it('writes nothing when the fields are invalid', async () => {
    const { io, bytes } = fakeDevice();
    await expect(writeLabel(io, '/dev/sda1', { ...FIELDS, poolId: '' })).rejects.toThrow();
    expect(bytes.every((byte) => byte === 0xaa)).toBe(true);
  });
});
