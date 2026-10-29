/** Raised when the socket cannot be reached at all. */
export class CoreUnavailableError extends Error {
  override readonly name = 'CoreUnavailableError';
}
