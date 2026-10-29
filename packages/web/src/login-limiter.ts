/**
 * Login rate limiting (decision 0008): 5 failures per client address in 15
 * minutes, counted in memory. Further attempts are refused until the oldest
 * failure leaves the window. A restart forgets the counts, which only helps
 * someone who can restart the service.
 */

const MAX_FAILURES = 5;
const WINDOW_MS = 900_000;

export class LoginLimiter {
  readonly #failures = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Milliseconds until `address` may try again, or 0 if it may now. */
  retryAfterMs(address: string): number {
    const recent = this.#recent(address);
    const [oldest] = recent;
    if (recent.length < MAX_FAILURES || oldest === undefined) {
      return 0;
    }
    return oldest + WINDOW_MS - this.#now();
  }

  recordFailure(address: string): void {
    this.#failures.set(address, [...this.#recent(address), this.#now()]);
  }

  /** A successful login clears the address's failures. */
  reset(address: string): void {
    this.#failures.delete(address);
  }

  #recent(address: string): number[] {
    const cutoff = this.#now() - WINDOW_MS;
    const recent = (this.#failures.get(address) ?? []).filter((at) => at > cutoff);
    if (recent.length === 0) {
      this.#failures.delete(address);
    } else {
      this.#failures.set(address, recent);
    }
    return recent;
  }
}
