/** What the API said went wrong. */
export interface Problem {
  /** The API's error code, such as "not-signed-in" or "rejected". */
  readonly code: string;
  readonly message: string;
  /** For a refusal: one sentence per reason. */
  readonly reasons?: readonly string[];
  /** What made the request fail before an answer, such as a network error. */
  readonly cause?: unknown;
}

/** A request the API answered with an error, or that never reached it. */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  /** The HTTP status, or 0 when the request failed before an answer. */
  readonly status: number;
  readonly code: string;
  readonly reasons: readonly string[];

  constructor(status: number, problem: Problem) {
    super(problem.message, { cause: problem.cause });
    this.status = status;
    this.code = problem.code;
    this.reasons = problem.reasons ?? [];
  }
}
