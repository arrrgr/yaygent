import { describe, expect, it } from 'vitest';
import { TokenBucket, HostSemaphore, HostBusyError, ConcurrencyCap } from '../../src/limits.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TokenBucket', () => {
  it('serves burst immediately then paces at the configured rate', async () => {
    const bucket = new TokenBucket(50, 1); // 50/s, burst 1 -> 20ms between takes
    const start = Date.now();
    await bucket.take();
    const afterFirst = Date.now() - start;
    expect(afterFirst).toBeLessThan(15);

    for (let i = 0; i < 5; i++) await bucket.take();
    const elapsed = Date.now() - start;
    // 5 paced takes at 20ms each = ~100ms; allow timer slack but not less than ~80ms
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(400);
  });

  it('estimates the queue wait so callers can skip instead of blocking', async () => {
    const bucket = new TokenBucket(0.25, 1); // 15 RPM unkeyed Jina
    expect(bucket.waitEstimateMs()).toBe(0);
    await bucket.take();
    expect(bucket.waitEstimateMs()).toBeGreaterThanOrEqual(3_900);
    const pending = [bucket.take(), bucket.take()];
    expect(bucket.waitEstimateMs()).toBeGreaterThanOrEqual(11_000);
    // do not leave timers running past the test
    void pending;
  });

  it('allows burst-sized concurrent takes without waiting', async () => {
    const bucket = new TokenBucket(1, 5);
    const start = Date.now();
    await Promise.all([bucket.take(), bucket.take(), bucket.take(), bucket.take(), bucket.take()]);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('HostSemaphore', () => {
  const make = (maxWaitMs = 100) =>
    new HostSemaphore({ defaultLimit: 2, tolerantHosts: ['linkedin.com', 'bing.com'], tolerantLimit: 8, maxWaitMs });

  it('applies the default limit per host and the tolerant limit to listed hosts', () => {
    const sem = make();
    expect(sem.limitFor('www.example.com')).toBe(2);
    expect(sem.limitFor('www.linkedin.com')).toBe(8);
    expect(sem.limitFor('cn.bing.com')).toBe(8);
  });

  it('throws HostBusyError after maxWaitMs when the host is saturated', async () => {
    const sem = make(60);
    const r1 = await sem.acquire('example.com');
    const r2 = await sem.acquire('www.example.com');
    expect(sem.activeFor('example.com')).toBe(2);

    const start = Date.now();
    await expect(sem.acquire('example.com')).rejects.toBeInstanceOf(HostBusyError);
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);

    r1();
    r2();
    expect(sem.activeFor('example.com')).toBe(0);
  });

  it('hands the slot to a waiter when one is released', async () => {
    const sem = make(500);
    const r1 = await sem.acquire('example.com');
    const r2 = await sem.acquire('example.com');
    const pending = sem.acquire('example.com');
    setTimeout(() => r1(), 10);
    const r3 = await pending;
    expect(sem.activeFor('example.com')).toBe(2);
    r2();
    r3();
  });

  it('does not block other hosts', async () => {
    const sem = make(50);
    await sem.acquire('a.com');
    await sem.acquire('a.com');
    const release = await sem.acquire('b.com');
    release();
  });

  it('release is idempotent', async () => {
    const sem = make();
    const release = await sem.acquire('c.com');
    release();
    release();
    expect(sem.activeFor('c.com')).toBe(0);
  });

  it('queues several waiters and never exceeds the limit', async () => {
    const sem = make(2_000);
    const r1 = await sem.acquire('q.com');
    const r2 = await sem.acquire('q.com');
    const waiters = [sem.acquire('q.com'), sem.acquire('q.com'), sem.acquire('q.com')];
    expect(sem.activeFor('q.com')).toBe(2);

    r1();
    const w1 = await waiters[0];
    expect(sem.activeFor('q.com')).toBe(2);
    r2();
    const w2 = await waiters[1];
    expect(sem.activeFor('q.com')).toBe(2);
    w1();
    const w3 = await waiters[2];
    expect(sem.activeFor('q.com')).toBe(2);
    w2();
    w3();
    expect(sem.activeFor('q.com')).toBe(0);
  });

  it('a timed-out waiter cannot later consume a slot', async () => {
    const sem = make(40);
    const r1 = await sem.acquire('t.com');
    const r2 = await sem.acquire('t.com');
    await expect(sem.acquire('t.com')).rejects.toBeInstanceOf(HostBusyError);

    // The rejected waiter must be off the queue: releasing both slots leaves the host idle.
    r1();
    r2();
    expect(sem.activeFor('t.com')).toBe(0);
    const fresh = await sem.acquire('t.com');
    expect(sem.activeFor('t.com')).toBe(1);
    fresh();
  });
});

describe('ConcurrencyCap (parse semaphore)', () => {
  it('is a HARD cap: no caller slips past while a waiter is being woken', async () => {
    const cap = new ConcurrencyCap(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let peak = 0;
    let inFlight = 0;

    const runs = gates.map((gate, i) =>
      cap.run(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate.promise;
        inFlight -= 1;
        return i;
      })
    );

    await new Promise((r) => setTimeout(r, 5));
    expect(cap.active).toBe(2);
    gates[0].resolve();
    // a new caller arriving exactly in the release window must not overtake the cap
    const late = cap.run(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      inFlight -= 1;
      return 99;
    });
    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all([...runs, late]);

    expect(peak).toBeLessThanOrEqual(2);
    expect(cap.active).toBe(0);
  });

  it('releases the slot when the body throws', async () => {
    const cap = new ConcurrencyCap(1);
    await expect(cap.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(cap.active).toBe(0);
    await expect(cap.run(async () => 'ok')).resolves.toBe('ok');
  });
});
