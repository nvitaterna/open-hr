/**
 * The client side of the socket (decision 0007), used by the CLI and by
 * ohr-web. Results and events are checked against the contract, so a caller
 * gets typed data or an error, never an unchecked shape.
 */

import { connect, type Socket } from 'node:net';

import { ConnectionClosedError } from './connection-closed-error.ts';
import {
  type EventName,
  eventMessageSchema,
  events,
  isEventName,
  type MethodName,
  methods,
  type Params,
  type Result,
  type RpcEvent,
  responseSchema,
} from './contract.ts';
import { CoreUnavailableError } from './core-unavailable-error.ts';
import { encodeLine, LineSplitter } from './framing.ts';
import { ProtocolError } from './protocol-error.ts';
import { RpcError } from './rpc-error.ts';

/** Connection errors that mean nothing is listening on the socket. */
const NOT_RUNNING = new Set(['ENOENT', 'ECONNREFUSED']);
const PERMISSION_DENIED = new Set(['EACCES', 'EPERM']);

interface Pending {
  readonly method: MethodName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new ProtocolError(String(error));
}

function errorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return null;
}

function describeConnectError(path: string, error: unknown): Error {
  const code = errorCode(error);
  if (code !== null && NOT_RUNNING.has(code)) {
    return new CoreUnavailableError(`ohr-core is not running: nothing is listening on ${path}.`);
  }
  if (code !== null && PERMISSION_DENIED.has(code)) {
    return new CoreUnavailableError(
      `Permission denied on ${path}. Run as root or as a member of the ohr group.`,
    );
  }
  return new CoreUnavailableError(`Could not connect to ohr-core on ${path}: ${String(error)}`);
}

export type EventListener = (event: RpcEvent) => void;

/** Methods a caller invokes with `call`. Subscribing goes through `subscribe`. */
export type CallableMethod = Exclude<MethodName, 'events.subscribe'>;

export class RpcClient {
  readonly #socket: Socket;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<EventListener>();
  readonly #closed: Promise<void>;
  #nextId = 1;
  #closeError: Error | null = null;

  private constructor(socket: Socket) {
    this.#socket = socket;
    const splitter = new LineSplitter();
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const line of splitter.push(chunk)) {
          this.#handleLine(line);
        }
      } catch (error) {
        this.#fail(asError(error));
      }
    });
    this.#closed = new Promise((resolve) => {
      socket.on('close', () => {
        this.#fail(new ConnectionClosedError('The connection to ohr-core closed.'));
        resolve();
      });
    });
    socket.on('error', (error) => this.#fail(error));
  }

  /** Connects to the socket at `path`. Throws CoreUnavailableError if core cannot be reached. */
  static connect(path: string): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const onError = (error: Error): void => {
        socket.destroy();
        reject(describeConnectError(path, error));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        resolve(new RpcClient(socket));
      });
    });
  }

  /** Resolves when the connection has closed, for whatever reason. */
  get closed(): Promise<void> {
    return this.#closed;
  }

  /** Calls a method. Rejects with RpcError when core answers with an error. */
  call<M extends CallableMethod>(method: M, params: Params<M>): Promise<Result<M>> {
    return this.#request(method, params) as Promise<Result<M>>;
  }

  /**
   * Starts receiving events, all of them or one job's. The listener is
   * registered before the request is sent, so no event is missed.
   */
  async subscribe(listener: EventListener, jobId?: string): Promise<void> {
    this.#listeners.add(listener);
    let params: Params<'events.subscribe'> = {};
    if (jobId !== undefined) {
      params = { jobId };
    }
    await this.#request('events.subscribe', params);
  }

  close(): Promise<void> {
    this.#socket.end();
    return this.#closed;
  }

  #request(method: MethodName, params: unknown): Promise<unknown> {
    if (this.#closeError !== null) {
      return Promise.reject(this.#closeError);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#socket.write(encodeLine({ id, method, params }));
    });
  }

  #handleLine(line: string): void {
    const message: unknown = JSON.parse(line);
    const event = eventMessageSchema.safeParse(message);
    if (event.success) {
      this.#handleEvent(event.data.event, event.data.data);
      return;
    }
    const response = responseSchema.safeParse(message);
    if (!response.success) {
      throw new ProtocolError('ohr-core sent a message that is neither a reply nor an event.');
    }
    const reply = response.data;
    // Only a request too broken to have an id gets an error without one. This client never sends one.
    if (reply.id === null) {
      if ('error' in reply) {
        throw RpcError.fromBody(reply.error);
      }
      throw new ProtocolError('ohr-core sent a result without an id.');
    }
    const pending = this.#pending.get(reply.id);
    if (pending === undefined) {
      throw new ProtocolError(`ohr-core answered request ${reply.id}, which was never sent.`);
    }
    this.#pending.delete(reply.id);
    if ('error' in reply) {
      pending.reject(RpcError.fromBody(reply.error));
      return;
    }
    const result = methods[pending.method].result.safeParse(reply.result);
    if (result.success) {
      pending.resolve(result.data);
    } else {
      pending.reject(new ProtocolError(`ohr-core sent an invalid result for ${pending.method}.`));
    }
  }

  #handleEvent(name: string, data: unknown): void {
    if (!isEventName(name)) {
      throw new ProtocolError(`ohr-core sent an unknown event ${name}.`);
    }
    const parsed = events[name].safeParse(data);
    if (!parsed.success) {
      throw new ProtocolError(`ohr-core sent an invalid ${name} event.`);
    }
    const event = { event: name as EventName, data: parsed.data } as RpcEvent;
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  /** Rejects every waiting call and closes the socket. Only the first error is kept. */
  #fail(error: Error): void {
    this.#closeError ??= error;
    for (const pending of this.#pending.values()) {
      pending.reject(this.#closeError);
    }
    this.#pending.clear();
    this.#socket.destroy();
  }
}
