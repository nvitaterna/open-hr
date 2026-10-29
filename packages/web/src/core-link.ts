/**
 * ohr-web's one connection to ohr-core (decision 0008). API requests share
 * it, and it holds a single event subscription that it fans out to every
 * open browser stream. When core goes away, calls fail until it is back, and
 * the subscription is retried every few seconds while anyone is listening.
 * After it comes back, listeners get a `state.changed` so they fetch again.
 */

import { type CallableMethod, type EventListener, RpcClient } from '@ohr/rpc/client';
import type { Params, Result, RpcEvent } from '@ohr/rpc/contract';

const DEFAULT_RETRY_MS = 2000;

export interface CoreLinkOptions {
  readonly socketPath: string;
  /** How long to wait before subscribing again after core went away. */
  readonly retryMs?: number;
  readonly log?: (line: string) => void;
}

export class CoreLink {
  readonly #socketPath: string;
  readonly #retryMs: number;
  readonly #log: (line: string) => void;
  readonly #listeners = new Set<EventListener>();
  #client: Promise<RpcClient> | null = null;
  /** The connection that carries the subscription, or null when there is none. */
  #subscribedOn: RpcClient | null = null;
  #retry: NodeJS.Timeout | null = null;
  /** How many times the subscription was made, counting each time core came back. */
  #subscriptions = 0;
  readonly #closing = new AbortController();

  constructor(options: CoreLinkOptions) {
    this.#socketPath = options.socketPath;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.#log = options.log ?? (() => undefined);
  }

  /** Calls a core method. Rejects with CoreUnavailableError when core cannot be reached. */
  async call<M extends CallableMethod>(method: M, params: Params<M>): Promise<Result<M>> {
    const client = await this.#connect();
    return client.call(method, params);
  }

  /** Starts sending core's events to `listener`. Returns the function that stops it. */
  listen(listener: EventListener): () => void {
    this.#listeners.add(listener);
    this.#subscribe();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Number of listeners, for tests. */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  async close(): Promise<void> {
    this.#closing.abort();
    this.#listeners.clear();
    if (this.#retry !== null) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
    const pending = this.#client;
    this.#client = null;
    if (pending !== null) {
      const client = await pending.catch(() => null);
      await client?.close();
    }
  }

  #connect(): Promise<RpcClient> {
    if (this.#closing.signal.aborted) {
      return Promise.reject(new Error('The link to ohr-core is closed.'));
    }
    if (this.#client === null) {
      const attempt = RpcClient.connect(this.#socketPath);
      this.#client = attempt;
      attempt.then(
        (client) => client.closed.then(() => this.#dropped(attempt, client)),
        () => {
          if (this.#client === attempt) {
            this.#client = null;
          }
        },
      );
    }
    return this.#client;
  }

  #dropped(attempt: Promise<RpcClient>, client: RpcClient): void {
    if (this.#client === attempt) {
      this.#client = null;
    }
    if (this.#subscribedOn === client) {
      this.#subscribedOn = null;
      this.#log('The connection to ohr-core closed.');
      this.#scheduleRetry();
    }
  }

  #scheduleRetry(): void {
    if (this.#closing.signal.aborted || this.#retry !== null || this.#listeners.size === 0) {
      return;
    }
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#subscribe();
    }, this.#retryMs);
    this.#retry.unref();
  }

  /** Makes sure the current connection carries the subscription. Never rejects. */
  #subscribe(): void {
    this.#ensureSubscribed().catch((error: unknown) => {
      this.#log(`Subscribing to ohr-core failed: ${String(error)}`);
      this.#scheduleRetry();
    });
  }

  async #ensureSubscribed(): Promise<void> {
    const client = await this.#connect();
    if (this.#subscribedOn === client) {
      return;
    }
    this.#subscribedOn = client;
    try {
      await client.subscribe((event) => this.#fanOut(event));
    } catch (error) {
      this.#subscribedOn = null;
      throw error;
    }
    if (this.#subscriptions > 0) {
      // Events may have been missed while core was away.
      const { readAt, stateHash } = await client.call('system.state', {});
      this.#fanOut({ event: 'state.changed', data: { readAt, stateHash } });
    }
    this.#subscriptions += 1;
  }

  #fanOut(event: RpcEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
