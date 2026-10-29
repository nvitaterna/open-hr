/** Raised when a stored job and the definition offered for it do not match. */
export class JobMismatchError extends Error {
  override readonly name = 'JobMismatchError';
}
