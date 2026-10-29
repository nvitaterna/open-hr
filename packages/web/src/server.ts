/**
 * ohr-web's HTTP server (plan section 5.5 and decision 0008): the account
 * endpoints and the rules every API request goes through.
 *
 * - Until the admin account exists, every API route except setup answers
 *   409 setup-required.
 * - Every request that changes something must be JSON and carry an Origin
 *   header naming this server. With the SameSite=Strict cookie that stops
 *   cross-site requests without a CSRF token.
 * - Every route is private unless it says `config: { public: true }`.
 */

import { createHash, randomBytes } from 'node:crypto';

import fastifyCookie from '@fastify/cookie';
import fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { ZodError, type z } from 'zod';

import {
  loginRequestSchema,
  type Me,
  type SetupStatus,
  setupRequestSchema,
} from '@ohr/shared/web-api';

import type { LoginLimiter } from './login-limiter.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import { checkSetupToken, removeSetupToken } from './setup-token.ts';
import type { WebStore } from './web-store.ts';

const API_PREFIX = '/api/';
const SETUP_PATH = '/api/v1/setup';
const SESSION_COOKIE = 'ohr_session';
const SESSION_BYTES = 32;
const SESSION_IDLE_MS = 604_800_000;
const MS_PER_SECOND = 1000;
const SESSION_IDLE_SECONDS = SESSION_IDLE_MS / MS_PER_SECOND;
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const JSON_TYPE = 'application/json';
/** Not a real password hash: login verifies against it when there is no admin, to take the same time. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const HTTP = {
  ok: 200,
  created: 201,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  unsupportedMediaType: 415,
  tooManyRequests: 429,
  internalError: 500,
} as const;

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

class ApiProblem extends Error {
  override readonly name = 'ApiProblem';
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  return schema.parse(body ?? {});
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
  /** The file holding the one-time setup token. */
  readonly setupTokenPath: string;
  /** Cookies are Secure except when serving plain HTTP for development. */
  readonly secureCookies: boolean;
  /** TLS key and certificate, or null to serve plain HTTP. */
  readonly tls: { readonly key: Buffer; readonly cert: Buffer } | null;
  readonly now?: () => Date;
  readonly logger?: boolean;
}

/** Builds the server without listening, so tests can drive it with inject(). */
export async function buildWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const now = options.now ?? (() => new Date());
  const { store, limiter } = options;
  const app = createApp(options);
  await app.register(fastifyCookie);
  app.decorateRequest('username', null);

  function startSession(reply: FastifyReply): void {
    const token = randomBytes(SESSION_BYTES).toString('base64url');
    const at = now();
    store.deleteIdleSessions(new Date(at.getTime() - SESSION_IDLE_MS).toISOString());
    store.createSession(sessionHash(token), at.toISOString());
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: options.secureCookies,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_IDLE_SECONDS,
    });
  }

  function signedIn(request: FastifyRequest): string | null {
    const token = request.cookies[SESSION_COOKIE];
    const admin = store.admin();
    if (token === undefined || admin === null) {
      return null;
    }
    const at = now();
    const cutoff = new Date(at.getTime() - SESSION_IDLE_MS).toISOString();
    if (!store.useSession(sessionHash(token), at.toISOString(), cutoff)) {
      return null;
    }
    return admin.username;
  }

  function throttle(request: FastifyRequest, reply: FastifyReply): void {
    const waitMs = limiter.retryAfterMs(request.ip);
    if (waitMs > 0) {
      reply.header('retry-after', String(Math.ceil(waitMs / MS_PER_SECOND)));
      throw new ApiProblem(
        HTTP.tooManyRequests,
        'too-many-attempts',
        'Too many failed attempts. Try again later.',
      );
    }
  }

  /** The rules every API request goes through. Throws ApiProblem to refuse it. */
  function guard(request: FastifyRequest): void {
    if (!request.url.startsWith(API_PREFIX)) {
      return;
    }
    if (isMutation(request)) {
      checkRequestSafety(request);
    }
    if (!request.url.startsWith(SETUP_PATH) && store.admin() === null) {
      throw new ApiProblem(HTTP.conflict, 'setup-required', 'Create the admin account first.');
    }
    if (request.routeOptions.config.public !== true) {
      request.username = signedIn(request);
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
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
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

  app.setNotFoundHandler((_request, reply) =>
    reply.code(HTTP.notFound).send({ error: 'not-found', message: 'There is nothing here.' }),
  );

  app.get(
    SETUP_PATH,
    { config: { public: true } },
    (): SetupStatus => ({
      required: store.admin() === null,
    }),
  );

  app.post(SETUP_PATH, { config: { public: true } }, async (request, reply) => {
    const body = parseBody(setupRequestSchema, request.body);
    if (store.admin() !== null) {
      throw new ApiProblem(HTTP.conflict, 'already-set-up', 'The admin account already exists.');
    }
    throttle(request, reply);
    if (!(await checkSetupToken(options.setupTokenPath, body.token))) {
      limiter.recordFailure(request.ip);
      throw new ApiProblem(
        HTTP.forbidden,
        'invalid-token',
        'That is not the setup token. Run "ohr-web setup-token" as root for a new one.',
      );
    }
    const passwordHash = await hashPassword(body.password);
    if (!store.createAdmin({ username: body.username, passwordHash }, now().toISOString())) {
      throw new ApiProblem(HTTP.conflict, 'already-set-up', 'The admin account already exists.');
    }
    await removeSetupToken(options.setupTokenPath);
    limiter.reset(request.ip);
    startSession(reply);
    const me: Me = { username: body.username };
    return reply.code(HTTP.created).send(me);
  });

  app.post('/api/v1/auth/login', { config: { public: true } }, async (request, reply) => {
    const body = parseBody(loginRequestSchema, request.body);
    throttle(request, reply);
    const admin = store.admin();
    // Always verify, so a wrong username takes as long as a wrong password.
    const passwordMatches = await verifyPassword(body.password, admin?.passwordHash ?? DUMMY_HASH);
    if (admin === null || !passwordMatches || body.username !== admin.username) {
      limiter.recordFailure(request.ip);
      throw new ApiProblem(
        HTTP.unauthorized,
        'invalid-credentials',
        'The username or password is wrong.',
      );
    }
    limiter.reset(request.ip);
    startSession(reply);
    const me: Me = { username: admin.username };
    return reply.code(HTTP.ok).send(me);
  });

  app.post('/api/v1/auth/logout', { config: { public: true } }, (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined) {
      store.deleteSession(sessionHash(token));
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(HTTP.noContent).send();
  });

  app.get('/api/v1/auth/me', (request): Me => ({ username: request.username ?? '' }));

  return app;
}
