/**
 * Holds the latest system snapshot so clients never wait for a full read
 * (plan section 5.4). Refreshes are coalesced: a refresh asked for while one
 * is running starts one more read after it, never two at once.
 */

import type { SystemSnapshot } from '@ohr/shared/system-snapshot';

import { systemStateHash } from '../jobs/state-hash.ts';

export interface CachedState {
  readonly snapshot: SystemSnapshot;
  /** ISO 8601 time the read finished. */
  readonly readAt: string;
  readonly stateHash: string;
}

export interface StateCacheOptions {
  readonly read: () => Promise<SystemSnapshot>;
  /** Called after a refresh whose snapshot differs from the one before. */
  readonly onChange: (state: CachedState) => void;
  readonly now?: () => Date;
}

export class StateCache {
  readonly #options: StateCacheOptions;
  #current: CachedState | null = null;
  #currentJson = '';
  #running: Promise<CachedState> | null = null;
  #queued: Promise<CachedState> | null = null;

  constructor(options: StateCacheOptions) {
    this.#options = options;
  }

  /** The cached state, reading it first if there is none yet. */
  get(): Promise<CachedState> {
    if (this.#current !== null) {
      return Promise.resolve(this.#current);
    }
    return this.refresh();
  }

  /** Reads the system again. Resolves with a state read after this call was made. */
  refresh(): Promise<CachedState> {
    if (this.#running === null) {
      this.#running = this.#start();
      return this.#running;
    }
    // A read is already under way and may have started before whatever prompted this call.
    this.#queued ??= this.#running
      .catch(() => null)
      .then(() => {
        this.#queued = null;
        this.#running = this.#start();
        return this.#running;
      });
    return this.#queued;
  }

  #start(): Promise<CachedState> {
    const read: Promise<CachedState> = this.#read().finally(() => {
      if (this.#running === read) {
        this.#running = null;
      }
    });
    return read;
  }

  async #read(): Promise<CachedState> {
    const snapshot = await this.#options.read();
    const json = JSON.stringify(snapshot);
    const state: CachedState = {
      snapshot,
      readAt: (this.#options.now?.() ?? new Date()).toISOString(),
      stateHash: systemStateHash(snapshot),
    };
    const changed = this.#current !== null && json !== this.#currentJson;
    this.#current = state;
    this.#currentJson = json;
    if (changed) {
      this.#options.onChange(state);
    }
    return state;
  }
}
