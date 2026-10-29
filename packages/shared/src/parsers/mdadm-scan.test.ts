import { describe, expect, it } from 'vitest';

import { parseMdadmScan } from './mdadm-scan.ts';
import { ParseError } from './parse-error.ts';

const SCAN = `ARRAY /dev/md/ohr_dev_t1 metadata=1.2 UUID=140b5ec3:72c1c4ad:6daf496c:2a364b9a
ARRAY /dev/md/ohr_dev_t2 metadata=1.2 UUID=f5126f62:e4406841:d9539c70:fd003a2e
`;

const VERBOSE = `ARRAY /dev/md/ohr_dev_t4 level=raid1 num-devices=2 metadata=1.2 UUID=b8f68109:6170bca0:e65ee886:04bb64d7
   devices=/dev/sdf5,/dev/sdg5
`;

describe('parseMdadmScan', () => {
  it('reads one definition per ARRAY line', () => {
    expect(parseMdadmScan(SCAN)).toEqual([
      {
        device: '/dev/md/ohr_dev_t1',
        metadata: '1.2',
        uuid: '140b5ec3:72c1c4ad:6daf496c:2a364b9a',
      },
      {
        device: '/dev/md/ohr_dev_t2',
        metadata: '1.2',
        uuid: 'f5126f62:e4406841:d9539c70:fd003a2e',
      },
    ]);
  });

  it('ignores continuation lines and extra fields from --verbose', () => {
    expect(parseMdadmScan(VERBOSE)).toEqual([
      {
        device: '/dev/md/ohr_dev_t4',
        metadata: '1.2',
        uuid: 'b8f68109:6170bca0:e65ee886:04bb64d7',
      },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseMdadmScan('')).toEqual([]);
  });

  it('rejects an ARRAY line without a UUID', () => {
    expect(() => parseMdadmScan('ARRAY /dev/md0 metadata=1.2\n')).toThrow(ParseError);
  });
});
