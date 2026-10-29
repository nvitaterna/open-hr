/**
 * Serves the UI build (decision 0010). Hashed assets are cached for a year;
 * index.html never is, so a new release shows on the next load. A GET for a
 * page such as /drives answers index.html and the UI's router takes over.
 */

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const INDEX = 'index.html';
const API_PREFIX = '/api/';
const ASSETS_PREFIX = '/assets/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

/** Sent with every response. The UI needs nothing from another origin and no inline script. */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** Adds the security headers to every response, the API's included. */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.headers(SECURITY_HEADERS);
    done(null, payload);
  });
}

/** Serves the files in `dir`. */
export async function registerUi(app: FastifyInstance, dir: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: dir,
    index: false,
    wildcard: true,
    setHeaders: (response, path) => {
      if (path.includes(ASSETS_PREFIX)) {
        response.header('cache-control', IMMUTABLE);
      } else {
        response.header('cache-control', NO_CACHE);
      }
    },
  });
  // The static handler answers a directory with 403, so the root needs its own route.
  app.get('/', (_request, reply) => sendIndex(reply));
}

/** True for a browser asking for a page rather than a file or the API. */
export function isPageRequest(request: FastifyRequest): boolean {
  return request.method === 'GET' && !request.url.startsWith(API_PREFIX);
}

/** Answers a page request with the UI's index.html. */
export function sendIndex(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', NO_CACHE).sendFile(INDEX);
}
