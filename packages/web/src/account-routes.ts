/**
 * The account endpoints (decision 0008): setup with the one-time token,
 * sign-in with the login limit, sign-out, and who is signed in. Sessions are
 * a random cookie whose SHA-256 is all the database keeps.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  loginRequestSchema,
  type Me,
  type SetupStatus,
  setupRequestSchema,
} from '@ohr/shared/web-api';

import { ApiProblem, HTTP } from './api-problem.ts';
import type { LoginLimiter } from './login-limiter.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import { checkSetupToken, removeSetupToken } from './setup-token.ts';
import type { WebStore } from './web-store.ts';

const SESSION_COOKIE = 'ohr_session';
const SESSION_BYTES = 32;
const SESSION_IDLE_MS = 604_800_000;
const MS_PER_SECOND = 1000;
const SESSION_IDLE_SECONDS = SESSION_IDLE_MS / MS_PER_SECOND;
/** Not a real password hash: login verifies against it when there is no admin, to take the same time. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function startSession(accounts: Accounts, reply: FastifyReply): void {
  const { store, now } = accounts;
  const token = randomBytes(SESSION_BYTES).toString('base64url');
  const at = now();
  store.deleteIdleSessions(new Date(at.getTime() - SESSION_IDLE_MS).toISOString());
  store.createSession(sessionHash(token), at.toISOString());
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: accounts.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_IDLE_SECONDS,
  });
}

function throttle(limiter: LoginLimiter, request: FastifyRequest, reply: FastifyReply): void {
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

function registerSetup(app: FastifyInstance, accounts: Accounts): void {
  const { store, limiter, now } = accounts;
  app.get(
    SETUP_PATH,
    { config: { public: true } },
    (): SetupStatus => ({
      required: store.admin() === null,
    }),
  );

  app.post(SETUP_PATH, { config: { public: true } }, async (request, reply) => {
    const body = setupRequestSchema.parse(request.body ?? {});
    if (store.admin() !== null) {
      throw new ApiProblem(HTTP.conflict, 'already-set-up', 'The admin account already exists.');
    }
    throttle(limiter, request, reply);
    if (!(await checkSetupToken(accounts.setupTokenPath, body.token))) {
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
    await removeSetupToken(accounts.setupTokenPath);
    limiter.reset(request.ip);
    startSession(accounts, reply);
    const me: Me = { username: body.username };
    return reply.code(HTTP.created).send(me);
  });
}

function registerSession(app: FastifyInstance, accounts: Accounts): void {
  const { store, limiter } = accounts;
  app.post('/api/v1/auth/login', { config: { public: true } }, async (request, reply) => {
    const body = loginRequestSchema.parse(request.body ?? {});
    throttle(limiter, request, reply);
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
    startSession(accounts, reply);
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
}

export const SETUP_PATH = '/api/v1/setup';

export interface Accounts {
  readonly store: WebStore;
  readonly limiter: LoginLimiter;
  /** The file holding the one-time setup token. */
  readonly setupTokenPath: string;
  /** Cookies are Secure except when serving plain HTTP for development. */
  readonly secureCookies: boolean;
  readonly now: () => Date;
}

/** The admin's username when the request carries a live session, else null. Using a session keeps it alive. */
export function sessionUser(accounts: Accounts, request: FastifyRequest): string | null {
  const { store, now } = accounts;
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

export function registerAccountRoutes(app: FastifyInstance, accounts: Accounts): void {
  registerSetup(app, accounts);
  registerSession(app, accounts);
}
