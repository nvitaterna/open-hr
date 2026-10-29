/** The HTTP status codes ohr-web answers with. */
export const HTTP = {
  ok: 200,
  created: 201,
  accepted: 202,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  unsupportedMediaType: 415,
  unprocessable: 422,
  tooManyRequests: 429,
  internalError: 500,
  serviceUnavailable: 503,
} as const;

/** A refusal with a status, a stable code, and a sentence for people. Routes throw it. */
export class ApiProblem extends Error {
  override readonly name = 'ApiProblem';
  readonly statusCode: number;
  readonly code: string;
  readonly reasons: readonly string[];

  constructor(statusCode: number, code: string, message: string, reasons: readonly string[] = []) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.reasons = reasons;
  }
}
