/** Raised when a message is longer than the framing allows. */
export class LineTooLongError extends Error {
  override readonly name = 'LineTooLongError';
}
