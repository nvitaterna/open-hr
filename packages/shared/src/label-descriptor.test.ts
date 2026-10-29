import { describe, expect, it } from 'vitest';

import {
  decodeLabelDescriptor,
  encodeLabelDescriptor,
  LabelDescriptorError,
  type LabelFields,
  MAX_LABEL_DESCRIPTOR_BYTES,
} from './label-descriptor.ts';

const FIELDS: LabelFields = {
  poolId: 'p1',
  poolUuid: '6f1c2b0e-8a3d-4c5e-9f7a-1b2c3d4e5f60',
  driveUuid: '0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70',
  redundancy: 'shr1',
  writtenAt: '2026-10-29T12:00:00.000Z',
};

const DRIVE_UUID_ERROR = /driveUuid/u;

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** A label partition's first bytes: `content`, then zeros. */
function partition(content: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(MAX_LABEL_DESCRIPTOR_BYTES * 2);
  bytes.set(content);
  return bytes;
}

describe('label descriptor', () => {
  it('writes one JSON line with the format and layout version', () => {
    const line = new TextDecoder().decode(encodeLabelDescriptor(FIELDS));
    expect(line.endsWith('}\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ format: 'open-hr-label', layoutVersion: 1, ...FIELDS });
  });

  it('reads back what it wrote', () => {
    expect(decodeLabelDescriptor(partition(encodeLabelDescriptor(FIELDS)))).toEqual({
      kind: 'ok',
      descriptor: { format: 'open-hr-label', layoutVersion: 1, ...FIELDS },
    });
  });

  it('refuses to write bad fields', () => {
    expect(() => encodeLabelDescriptor({ ...FIELDS, poolId: 'Pool-1' })).toThrow(
      LabelDescriptorError,
    );
    expect(() => encodeLabelDescriptor({ ...FIELDS, driveUuid: 'sda' })).toThrow(DRIVE_UUID_ERROR);
  });

  it('calls a zeroed partition empty', () => {
    expect(decodeLabelDescriptor(partition(new Uint8Array()))).toEqual({ kind: 'empty' });
  });

  it('leaves a label from a newer layout version alone', () => {
    const newer = text(JSON.stringify({ format: 'open-hr-label', layoutVersion: 2, extra: true }));
    expect(decodeLabelDescriptor(partition(newer))).toEqual({
      kind: 'unsupported',
      layoutVersion: 2,
    });
  });

  it.each([
    ['random bytes', new Uint8Array([0xff, 0xfe, 0x01])],
    ['text that is not JSON', text('hello')],
    ['JSON from something else', text('{"format":"other","layoutVersion":1}')],
    ['a JSON array', text('[1,2]')],
  ])('rejects %s', (_name, content) => {
    expect(decodeLabelDescriptor(partition(content))).toMatchObject({ kind: 'invalid' });
  });

  it('names the field that is wrong', () => {
    const missing = text(
      JSON.stringify({ format: 'open-hr-label', layoutVersion: 1, poolId: 'p1' }),
    );
    expect(decodeLabelDescriptor(partition(missing))).toMatchObject({
      kind: 'invalid',
      reason: expect.stringContaining('poolUuid'),
    });
  });

  it('never reads past the descriptor limit', () => {
    const bytes = new Uint8Array(MAX_LABEL_DESCRIPTOR_BYTES + 10).fill(0x20);
    bytes.set(text('{}'), MAX_LABEL_DESCRIPTOR_BYTES);
    expect(decodeLabelDescriptor(bytes)).toEqual({ kind: 'empty' });
  });
});
