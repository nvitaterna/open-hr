/**
 * `GET /api/v1/events` (decision 0008): server-sent events relaying core's
 * events to the browser. Each event goes out under its core name, such as
 * `job.step`, with its data as JSON. A comment every 15 seconds keeps proxies
 * from closing a quiet stream. Closing the server ends every open stream.
 */

import type { ServerResponse } from 'node:http';

import type { FastifyInstance } from 'fastify';

import type { RpcEvent } from '@ohr/rpc/contract';

import { HTTP } from './api-problem.ts';
import type { CoreLink } from './core-link.ts';

const DEFAULT_KEEPALIVE_MS = 15_000;
/** How long a browser waits before reconnecting a stream that dropped. */
const RECONNECT_MS = 3000;

function frame(event: RpcEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** Registers the route. It is private like every other. */
export function registerEventStream(
  app: FastifyInstance,
  core: CoreLink,
  keepaliveMs = DEFAULT_KEEPALIVE_MS,
): void {
  const open = new Set<ServerResponse>();

  // preClose, not onClose: the server only finishes closing once these streams have ended.
  app.addHook('preClose', (done) => {
    for (const response of open) {
      response.end();
    }
    done();
  });

  app.get('/api/v1/events', (_request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(HTTP.ok, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(`retry: ${RECONNECT_MS}\n\n`);
    open.add(response);
    const stopListening = core.listen((event) => response.write(frame(event)));
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), keepaliveMs);
    // The response closes when the browser goes away or the server ends the stream.
    response.on('close', () => {
      clearInterval(keepalive);
      stopListening();
      open.delete(response);
    });
  });
}
