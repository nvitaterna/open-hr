/**
 * The browser's side of ohr-web's API (decision 0008). Every call is
 * same-origin, so the session cookie goes along by itself. Errors become
 * ApiRequestError with the API's code and message.
 */

import { type ApiError, apiErrorSchema } from '@ohr/shared/web-api';

import { ApiRequestError } from './api-request-error.ts';

const API_BASE = '/api/v1';
const NO_CONTENT = 204;

async function errorFrom(response: Response): Promise<ApiRequestError> {
  let body: ApiError | null = null;
  try {
    const parsed = apiErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      body = parsed.data;
    }
  } catch {
    // Not JSON, for example a proxy's error page.
  }
  if (body === null) {
    return new ApiRequestError(response.status, {
      code: 'unexpected',
      message: `The server answered ${response.status} ${response.statusText}.`,
    });
  }
  return new ApiRequestError(response.status, {
    code: body.error,
    message: body.message,
    reasons: body.reasons ?? [],
  });
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (error) {
    throw new ApiRequestError(0, {
      code: 'network',
      message: 'Could not reach Open HR. Is ohr-web running?',
      cause: error,
    });
  }
  if (!response.ok) {
    throw await errorFrom(response);
  }
  if (response.status === NO_CONTENT) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** GETs `path` under /api/v1. The answer is typed by the caller; web checked it against core's contract. */
export function apiGet<T>(path: string): Promise<T> {
  return send(path, { headers: { accept: 'application/json' } });
}

/** POSTs `body` as JSON to `path` under /api/v1. */
export function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  return send(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
