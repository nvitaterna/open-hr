import { describe, expect, it } from 'vitest';

import { LoginLimiter } from './login-limiter.ts';

const MINUTE = 60_000;

describe('LoginLimiter', () => {
  it('allows 5 failures in 15 minutes, then makes the address wait', () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.retryAfterMs('10.0.0.1')).toBe(0);
      limiter.recordFailure('10.0.0.1');
      now += MINUTE;
    }
    expect(limiter.retryAfterMs('10.0.0.1')).toBe(10 * MINUTE);
    expect(limiter.retryAfterMs('10.0.0.2')).toBe(0);
    now = 15 * MINUTE + 1;
    expect(limiter.retryAfterMs('10.0.0.1')).toBe(0);
  });

  it('forgets an address after a successful login', () => {
    const limiter = new LoginLimiter(() => 0);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure('10.0.0.1');
    }
    limiter.reset('10.0.0.1');
    expect(limiter.retryAfterMs('10.0.0.1')).toBe(0);
  });
});
