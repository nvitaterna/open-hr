/**
 * The server side of the socket (decision 0007). It owns the framing, checks
 * every request against the contract, calls the matching handler, and sends
 * events to the connections that subscribed. Setting up the socket file's
 * owner and mode is the daemon's job, not this module's.
 */

import { createServer, type Server, type Socket } from 'node:net';

import {
  type EventData,
  type EventName,
  isMethodName,
  type MethodName,
  methods,
  type Params,
  type ParsedParams,
  type Result,
  requestSchema,
} from './contract.ts';
import { encodeLine, LineSplitter } from './framing.ts';
import { LineTooLongError } from './line-too-long-error.ts';
import { RpcError } from './rpc-error.ts';

const SUBSCRIBE = 'events.subscribe';
const MAX_REPORTED_ISSUES = 3;

interface Subscription {
  readonly jobId: string | null;
}

interface Connection {
  readonly socket: Socket;
  subscription: Subscription | null;
}

function describeIssues(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function send(connection: Connection, message: unknown): void {
  if (!connection.socket.destroyed) {
    connection.socket.write(encodeLine(message));
  }
}

function sendError(connection: Connection, id: number | null, error: RpcError): void {
  send(connection, { id, error: error.toBody() });
}

function eventJobId(data: unknown): string | null {
  if (
    typeof data === 'object' &&
    data !== null &&
    'jobId' in data &&
    typeof data.jobId === 'string'
  ) {
    return data.jobId;
  }
  return null;
}

/** Methods core implements. Subscribing is handled by the server itself. */
export type HandledMethod = Exclude<MethodName, typeof SUBSCRIBE>;

export type Handlers = {
  readonly [M in HandledMethod]: (params: ParsedParams<M>) => Promise<Result<M>>;
};

export interface RpcServerOptions {
  readonly handlers: Handlers;
  /** Called with a line for the daemon's log when something goes wrong. */
  readonly log: (line: string) => void;
}

export class RpcServer {
  readonly #server: Server;
  readonly #options: RpcServerOptions;
  readonly #connections = new Set<Connection>();

  private constructor(options: RpcServerOptions) {
    this.#options = options;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  /** Listens on the unix socket at `path`. The path must not exist. */
  static listen(path: string, options: RpcServerOptions): Promise<RpcServer> {
    const rpc = new RpcServer(options);
    return new Promise((resolve, reject) => {
      rpc.#server.once('error', reject);
      rpc.#server.listen(path, () => {
        rpc.#server.off('error', reject);
        resolve(rpc);
      });
    });
  }

  /** Number of open connections. */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Sends an event to every subscribed connection whose filter matches. */
  publish<E extends EventName>(event: E, data: EventData<E>): void {
    const jobId = eventJobId(data);
    for (const connection of this.#connections) {
      const { subscription } = connection;
      if (subscription !== null && (subscription.jobId === null || subscription.jobId === jobId)) {
        send(connection, { event, data });
      }
    }
  }

  /** Stops accepting connections, closes the open ones, and removes the socket file. */
  close(): Promise<void> {
    for (const connection of this.#connections) {
      connection.socket.destroy();
    }
    return new Promise((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  #accept(socket: Socket): void {
    const connection: Connection = { socket, subscription: null };
    const splitter = new LineSplitter();
    this.#connections.add(connection);
    socket.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch (error) {
        if (error instanceof LineTooLongError) {
          sendError(connection, null, new RpcError('invalid-request', error.message));
          socket.end();
          return;
        }
        throw error;
      }
      for (const line of lines) {
        this.#handleLine(connection, line).catch((error: unknown) => {
          this.#options.log(`RPC request failed: ${String(error)}`);
        });
      }
    });
    socket.on('error', (error) => {
      this.#options.log(`RPC connection error: ${error.message}`);
    });
    socket.on('close', () => {
      this.#connections.delete(connection);
    });
  }

  async #handleLine(connection: Connection, line: string): Promise<void> {
    if (line.trim() === '') {
      return;
    }
    const request = requestSchema.safeParse(parseJson(line));
    if (!request.success) {
      sendError(connection, null, new RpcError('invalid-request', 'Not a valid request'));
      return;
    }
    const { id, method, params } = request.data;
    if (!isMethodName(method)) {
      sendError(connection, id, new RpcError('invalid-request', `Unknown method ${method}`));
      return;
    }
    const parsed = methods[method].params.safeParse(params);
    if (!parsed.success) {
      sendError(connection, id, new RpcError('invalid-params', describeIssues(parsed.error)));
      return;
    }
    try {
      const result = await this.#dispatch(connection, method, parsed.data);
      send(connection, { id, result });
    } catch (error) {
      if (error instanceof RpcError) {
        sendError(connection, id, error);
        return;
      }
      this.#options.log(`${method} failed: ${describeError(error)}`);
      sendError(
        connection,
        id,
        new RpcError('internal', 'Internal error in ohr-core. See its log.'),
      );
    }
  }

  #dispatch(connection: Connection, method: MethodName, params: unknown): Promise<unknown> {
    if (method === SUBSCRIBE) {
      const { jobId } = params as Params<typeof SUBSCRIBE>;
      connection.subscription = { jobId: jobId ?? null };
      return Promise.resolve({});
    }
    const handler = this.#options.handlers[method] as (params: unknown) => Promise<unknown>;
    return handler(params);
  }
}
