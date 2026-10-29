import type { ErrorBody, RpcErrorCode } from './contract.ts';

/**
 * An error that crosses the socket. Handlers in core throw it to send a
 * specific code; clients receive it when a call fails.
 */
export class RpcError extends Error {
  override readonly name = 'RpcError';
  readonly code: RpcErrorCode;
  readonly reasons: readonly string[];

  constructor(code: RpcErrorCode, message: string, reasons: readonly string[] = []) {
    super(message);
    this.code = code;
    this.reasons = reasons;
  }

  static fromBody(body: ErrorBody): RpcError {
    return new RpcError(body.code, body.message, body.reasons ?? []);
  }

  toBody(): ErrorBody {
    if (this.reasons.length === 0) {
      return { code: this.code, message: this.message };
    }
    return { code: this.code, message: this.message, reasons: [...this.reasons] };
  }
}
