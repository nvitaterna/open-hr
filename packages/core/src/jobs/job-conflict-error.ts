/** Raised when a pool already has a pending or running job. */
export class JobConflictError extends Error {
  override readonly name = 'JobConflictError';
}
