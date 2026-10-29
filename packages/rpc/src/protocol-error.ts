/** Raised when core sends something that does not match the contract. */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}
