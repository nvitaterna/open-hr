/**
 * Writes and reads the descriptor in a drive's label partition (decision 0004).
 * The same as `dd` of zeros and then the JSON by hand, done with direct writes
 * so no temporary file is needed.
 */

import { open } from 'node:fs/promises';

import { LABEL_PARTITION_BYTES } from '@ohr/shared/constants';
import {
  decodeLabelDescriptor,
  encodeLabelDescriptor,
  type LabelFields,
  type LabelReadResult,
  MAX_LABEL_DESCRIPTOR_BYTES,
} from '@ohr/shared/label-descriptor';

/** Raw access to a block device from offset 0. Injected so tests need no real device. */
export interface BlockDeviceIo {
  /** Writes `data` at offset 0 and flushes it to the device. */
  readonly write: (path: string, data: Uint8Array) => Promise<void>;
  /** Reads up to `length` bytes from offset 0. */
  readonly read: (path: string, length: number) => Promise<Uint8Array>;
}

export const blockDeviceIo: BlockDeviceIo = {
  async write(path, data) {
    const handle = await open(path, 'r+');
    try {
      await handle.write(data, 0, data.length, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async read(path, length) {
    const handle = await open(path, 'r');
    try {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

/** Zeros the whole label partition and writes the descriptor at its start. */
export async function writeLabel(
  io: BlockDeviceIo,
  partitionPath: string,
  fields: LabelFields,
): Promise<void> {
  const descriptor = encodeLabelDescriptor(fields);
  const data = new Uint8Array(LABEL_PARTITION_BYTES);
  data.set(descriptor);
  await io.write(partitionPath, data);
}

export async function readLabel(
  io: BlockDeviceIo,
  partitionPath: string,
): Promise<LabelReadResult> {
  return decodeLabelDescriptor(await io.read(partitionPath, MAX_LABEL_DESCRIPTOR_BYTES));
}
