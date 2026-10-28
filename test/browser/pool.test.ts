import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `chromium.launch` is stubbed, so nothing here touches a real browser or the network.
 * pool.ts had no tests at all: the acquire timeout, the initialize() race and the
 * recycle path were entirely unverified.
 */
const state = vi.hoisted(() => ({
  launches: 0,
  contextsCreated: 0,
  contextsClosed: 0,
  launchFails: 0,
  createFails: 0,
  launchDelayMs: 0,
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
      state.launches += 1;
      if (state.launchDelayMs) await new Promise((r) => setTimeout(r, state.launchDelayMs));
      if (state.launchFails > 0) {
        state.launchFails -= 1;
        throw new Error('launch failed');
      }
      return {
        newContext: async () => {
          if (state.createFails > 0) {
            state.createFails -= 1;
            throw new Error('context creation failed');
          }
          state.contextsCreated += 1;
          const ctx = {
            id: state.contextsCreated,
            addInitScript: async () => {},
            close: async () => {
              state.contextsClosed += 1;
            },
          };
          return ctx;
        },
        close: async () => {},
      };
    },
  },
}));

import { BrowserPool } from '../../src/browser/pool.js';

function reset() {
  state.launches = 0;
  state.contextsCreated = 0;
  state.contextsClosed = 0;
  state.launchFails = 0;
  state.createFails = 0;
  state.launchDelayMs = 0;
}

beforeEach(() => {
  reset();
  delete process.env['PROXY_URL_ROTATE'];
  delete process.env['PROXY_URL'];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserPool.initialize', () => {
  it('launches exactly one browser under concurrent callers', async () => {
    state.launchDelayMs = 20;
    const pool = new BrowserPool(3);
    await Promise.all([pool.initialize(), pool.initialize(), pool.initialize()]);
    expect(state.launches).toBe(1);
    expect(pool.size).toBe(3);
    expect(state.contextsCreated).toBe(3);
    await pool.close();
  });

  it('does not memoise a failed launch - the next caller retries', async () => {
    state.launchFails = 1;
    const pool = new BrowserPool(2);
    await expect(pool.initialize()).rejects.toThrow('launch failed');
    expect(pool.size).toBe(0);
    await pool.initialize();
    expect(pool.size).toBe(2);
    expect(state.launches).toBe(2);
    await pool.close();
  });

  it('is a no-op at pool size 0', async () => {
    const pool = new BrowserPool(0);
    await pool.initialize();
    expect(state.launches).toBe(0);
    expect(pool.size).toBe(0);
    expect(pool.configuredSize).toBe(0);
  });
});

describe('BrowserPool.acquire', () => {
  it('hands out every context, then queues', async () => {
    const pool = new BrowserPool(2);
    await pool.initialize();
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(pool.available).toBe(0);
    const pending = pool.acquire();
    setTimeout(() => pool.release(a), 5);
    const c = await pending;
    expect(c).toBe(a);
    pool.release(b);
    pool.release(c);
    expect(pool.available).toBe(2);
    await pool.close();
  });

  it('a timed-out waiter cannot silently consume a context forever', async () => {
    vi.useFakeTimers();
    const pool = new BrowserPool(1);
    await pool.initialize();
    const held = await pool.acquire();

    const timedOut = pool.acquire();
    const assertion = expect(timedOut).rejects.toThrow(/Browser pool timeout/);
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;

    // The dead waiter used to stay queued; the next release then marked the context busy
    // for a holder that had already rejected, burning it for the life of the process.
    pool.release(held);
    expect(pool.available).toBe(1);

    vi.useRealTimers();
    const again = await pool.acquire();
    expect(again).toBeDefined();
    pool.release(again);
    await pool.close();
  });
});

describe('BrowserPool recycle', () => {
  it('replaces a discarded context', async () => {
    const pool = new BrowserPool(1);
    await pool.initialize();
    const ctx = await pool.acquire();
    pool.discard(ctx);
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.size).toBe(1);
    expect(state.contextsCreated).toBe(2);
    expect(state.contextsClosed).toBe(1);
    await pool.close();
  });

  it('regrows after a failed recycle instead of shrinking to zero forever', async () => {
    const pool = new BrowserPool(2);
    pool.regrowDelayMs = 5;
    await pool.initialize();
    expect(pool.size).toBe(2);

    state.createFails = 1;
    const ctx = await pool.acquire();
    pool.discard(ctx);
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.size).toBe(1); // dropped for now

    await new Promise((r) => setTimeout(r, 60));
    expect(pool.size).toBe(2); // and grown back
    await pool.close();
  });

  it('recycles automatically after 50 uses', async () => {
    const pool = new BrowserPool(1);
    await pool.initialize();
    for (let i = 0; i < 49; i++) {
      const c = await pool.acquire();
      pool.release(c);
    }
    expect(state.contextsCreated).toBe(1);
    const last = await pool.acquire();
    pool.release(last);
    await new Promise((r) => setTimeout(r, 5));
    expect(state.contextsCreated).toBe(2);
    await pool.close();
  });
});

describe('BrowserPool.close', () => {
  it('closes every context and empties the pool', async () => {
    const pool = new BrowserPool(3);
    await pool.initialize();
    await pool.close();
    expect(pool.size).toBe(0);
    expect(state.contextsClosed).toBe(3);
  });
});
