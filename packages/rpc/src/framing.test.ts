import { describe, expect, it } from 'vitest';

import { encodeLine, LineSplitter } from './framing.ts';
import { LineTooLongError } from './line-too-long-error.ts';

describe('LineSplitter', () => {
  it('returns whole lines and keeps the rest for the next chunk', () => {
    const splitter = new LineSplitter();
    expect(splitter.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(splitter.push(Buffer.from(':2}\n\n'))).toEqual(['{"b":2}', '']);
  });

  it('joins a multi-byte character split across chunks', () => {
    const splitter = new LineSplitter();
    const bytes = Buffer.from('"é"\n');
    expect(splitter.push(bytes.subarray(0, 2))).toEqual([]);
    expect(splitter.push(bytes.subarray(2))).toEqual(['"é"']);
  });

  it('refuses a line longer than the limit, even before its newline arrives', () => {
    const splitter = new LineSplitter(8);
    expect(splitter.push(Buffer.from('12345678\n'))).toEqual(['12345678']);
    splitter.push(Buffer.from('12345'));
    expect(() => splitter.push(Buffer.from('6789'))).toThrow(LineTooLongError);
  });
});

describe('encodeLine', () => {
  it('writes one JSON line', () => {
    expect(encodeLine({ id: 1, method: 'jobs.list', params: {} })).toBe(
      '{"id":1,"method":"jobs.list","params":{}}\n',
    );
  });

  it('escapes newlines inside strings, so a message is always one line', () => {
    expect(encodeLine({ line: 'a\nb' }).split('\n')).toHaveLength(2);
  });
});
