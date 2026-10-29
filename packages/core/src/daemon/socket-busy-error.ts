/** Raised when another daemon already answers on the socket. */
export class SocketBusyError extends Error {
  override readonly name = 'SocketBusyError';
}
