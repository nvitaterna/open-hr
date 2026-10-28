import { describe, expect, it } from 'vitest';

import { alignDown, formatSize, parseSize, SizeParseError } from './sizes.ts';

describe('parseSize', () => {
  it.each([
    ['4TB', 4_000_000_000_000],
    ['4 TB', 4_000_000_000_000],
    ['3.5TB', 3_500_000_000_000],
    ['1TiB', 1_099_511_627_776],
    ['512MiB', 536_870_912],
    ['100B', 100],
  ])('parses %s', (text, bytes) => {
    expect(parseSize(text)).toBe(bytes);
  });

  it.each(['4', '4T', '4tb', 'TB', '', '-1TB', '4 terabytes'])('rejects %j', (text) => {
    expect(() => parseSize(text)).toThrow(SizeParseError);
  });

  it('rejects zero', () => {
    expect(() => parseSize('0TB')).toThrow(SizeParseError);
  });
});

describe('formatSize', () => {
  it.each([
    [999, '999 B'],
    [4_000_000_000_000, '4.00 TB'],
    [1_500_000_000, '1.50 GB'],
    [12_345_678_901_234, '12.34 TB'],
    [3_999_999_999_999, '3.99 TB'],
    [2_500_000_000_000_000, '2.50 PB'],
  ])('formats %d as %s', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
});

describe('alignDown', () => {
  it('rounds down to the alignment', () => {
    expect(alignDown(1_048_577, 1_048_576)).toBe(1_048_576);
    expect(alignDown(1_048_576, 1_048_576)).toBe(1_048_576);
  });
});
