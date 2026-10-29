/**
 * Newline-delimited JSON framing (decision 0007). Each message is one line of
 * at most MAX_LINE_BYTES bytes. The limit keeps a misbehaving client from
 * filling the root daemon's memory with a line that never ends.
 */

import { LineTooLongError } from './line-too-long-error.ts';

const NEWLINE = 0x0a;

/** 1 MiB. */
export const MAX_LINE_BYTES = 1_048_576;

/** Collects bytes from a stream and hands back whole lines. */
export class LineSplitter {
  readonly #maxBytes: number;
  #pending: Buffer[] = [];
  #pendingBytes = 0;

  constructor(maxBytes: number = MAX_LINE_BYTES) {
    this.#maxBytes = maxBytes;
  }

  /** Adds a chunk and returns every line it completed, without the newline. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let rest = chunk;
    let newline = rest.indexOf(NEWLINE);
    while (newline !== -1) {
      this.#append(rest.subarray(0, newline));
      lines.push(Buffer.concat(this.#pending).toString('utf8'));
      this.#pending = [];
      this.#pendingBytes = 0;
      rest = rest.subarray(newline + 1);
      newline = rest.indexOf(NEWLINE);
    }
    this.#append(rest);
    return lines;
  }

  #append(bytes: Buffer): void {
    this.#pendingBytes += bytes.length;
    if (this.#pendingBytes > this.#maxBytes) {
      throw new LineTooLongError(`A message is longer than ${this.#maxBytes} bytes`);
    }
    if (bytes.length > 0) {
      this.#pending.push(bytes);
    }
  }
}

/** One message as a line, ready to write. */
export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
