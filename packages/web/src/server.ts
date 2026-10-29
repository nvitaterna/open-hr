/**
 * ohr-web's HTTP server (plan section 5.5 and decision 0008): the rules
 * every API request goes through, around the routes from account-routes.ts,
 * api-routes.ts, event-stream.ts, and the UI files from ui-files.ts.
 *
 * - Until the admin account exists, every API route except setup answers
 *   409 setup-required.
 * - Every request that changes something must be JSON and carry an Origin
 *   header naming this server. With the SameSite=Strict cookie that stops
 *   cross-site requests without a CSRF token.
 * - Every route is private unless it says `config: { public: true }`.
 */

import fastifyCookie from '@fastify/cookie';
import fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import type { ApiError } from '@ohr/shared/web-api';

import { type Accounts, registerAccountRoutes, SETUP_PATH, sessionUser } from './account-routes.ts';
import { ApiProblem, HTTP } from './api-problem.ts';
import { registerApiRoutes } from './api-routes.ts';
import type { CoreLink } from './core-link.ts';
import { registerEventStream } from './event-stream.ts';
import type { LoginLimiter } from './login-limiter.ts';
import { isPageRequest, registerSecurityHeaders, registerUi, sendIndex } from './ui-files.ts';
import type { WebStore } from './web-store.ts';

const API_PREFIX = '/api/';
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const JSON_TYPE = 'application/json';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without a session. */
    readonly public?: boolean;
  }
  interface FastifyRequest {
    /** The signed-in user, set for private routes. */
    username: string | null;
  }
}

function describeZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}

function isMutation(request: FastifyRequest): boolean {
  return !SAFE_METHODS.has(request.method);
}

/** Refuses a change that is not JSON or does not come from a page this server served. */
function checkRequestSafety(request: FastifyRequest): void {
  const type = request.headers['content-type'] ?? '';
  if (!type.startsWith(JSON_TYPE)) {
    throw new ApiProblem(
      HTTP.unsupportedMediaType,
      'json-required',
      'Requests that change something must send JSON.',
    );
  }
  const expected = `${request.protocol}://${request.host}`;
  if (request.headers.origin !== expected) {
    throw new ApiProblem(
      HTTP.forbidden,
      'cross-origin',
      'This request did not come from a page Open HR served.',
    );
  }
}

/** Plain HTTP or HTTPS. Both are used through the same, HTTP-typed interface. */
function createApp(options: WebServerOptions): FastifyInstance {
  const logger = options.logger ?? false;
  if (options.tls === null) {
    return fastify({ logger });
  }
  return fastify({ logger, https: options.tls }) as unknown as FastifyInstance;
}

export interface WebServerOptions {
  readonly store: WebStore;
  readonly limiter: LoginLimiter;
  /** The connection to ohr-core that the system, pool, job, and event routes use. */
  readonly core: CoreLink;
  /** The file holding the one-time setup token. */
  readonly setupTokenPath: string;
  /** Cookies are Secure except when serving plain HTTP for development. */
  readonly secureCookies: boolean;
  /** TLS key and certificate, or null to serve plain HTTP. */
  readonly tls: { readonly key: Buffer; readonly cert: Buffer } | null;
  readonly now?: () => Date;
  readonly logger?: boolean;
  /** How often an idle event stream sends a keepalive comment. */
  readonly keepaliveMs?: number;
  /** The UI build to serve, or null to serve the API only. */
  readonly uiDir?: string | null;
}

/** Builds the server without listening, so tests can drive it with inject(). */
export async function buildWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const accounts: Accounts = {
    store: options.store,
    limiter: options.limiter,
    setupTokenPath: options.setupTokenPath,
    secureCookies: options.secureCookies,
    now: options.now ?? (() => new Date()),
  };
  const app = createApp(options);
  await app.register(fastifyCookie);
  registerSecurityHeaders(app);
  const uiDir = options.uiDir ?? null;
  if (uiDir !== null) {
    await registerUi(app, uiDir);
  }
  app.decorateRequest('username', null);

  /** The rules every API request goes through. Throws ApiProblem to refuse it. */
  function guard(request: FastifyRequest): void {
    if (!request.url.startsWith(API_PREFIX)) {
      return;
    }
    if (isMutation(request)) {
      checkRequestSafety(request);
    }
    if (!request.url.startsWith(SETUP_PATH) && accounts.store.admin() === null) {
      throw new ApiProblem(HTTP.conflict, 'setup-required', 'Create the admin account first.');
    }
    if (request.routeOptions.config.public !== true) {
      request.username = sessionUser(accounts, request);
      if (request.username === null) {
        throw new ApiProblem(HTTP.unauthorized, 'not-signed-in', 'Sign in first.');
      }
    }
  }

  app.addHook('onRequest', (request, _reply, done) => {
    try {
      guard(request);
      done();
    } catch (error) {
      done(error as ApiProblem);
    }
  });

  app.setErrorHandler((error: FastifyError | ApiProblem | ZodError, request, reply) => {
    if (error instanceof ApiProblem) {
      const body: ApiError = { error: error.code, message: error.message };
      if (error.reasons.length > 0) {
        body.reasons = [...error.reasons];
      }
      return reply.code(error.statusCode).send(body);
    }
    if (error instanceof ZodError) {
      return reply
        .code(HTTP.badRequest)
        .send({ error: 'invalid-request', message: describeZodError(error) });
    }
    if (error.statusCode !== undefined && error.statusCode < HTTP.internalError) {
      return reply
        .code(error.statusCode)
        .send({ error: 'invalid-request', message: error.message });
    }
    request.log.error(error);
    return reply
      .code(HTTP.internalError)
      .send({ error: 'internal', message: 'Something went wrong in ohr-web. See its log.' });
  });

  app.setNotFoundHandler((request, reply) => {
    if (uiDir !== null && isPageRequest(request)) {
      return sendIndex(reply);
    }
    return reply
      .code(HTTP.notFound)
      .send({ error: 'not-found', message: 'There is nothing here.' });
  });

  registerAccountRoutes(app, accounts);
  registerApiRoutes(app, options.core);
  registerEventStream(app, options.core, options.keepaliveMs);

  return app;
}
