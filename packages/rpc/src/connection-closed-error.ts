/** Raised for calls still waiting when the connection closes, and for calls made after. */
export class ConnectionClosedError extends Error {
  override readonly name = 'ConnectionClosedError';
}
