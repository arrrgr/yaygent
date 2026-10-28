/**
 * Process-wide rate and concurrency limits shared by the search and fetch layers.
 *
 * - TokenBucket: continuous refill, FIFO takers (Serper QPS, Jina RPM).
 * - HostSemaphore: per-host concurrency with a bounded wait (target sites).
 * - parseSemaphore: caps concurrent JSDOM/Readability parses (the OOM path).
 */

function envNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  readonly ratePerSec: number;
  readonly burst: number;

  constructor(ratePerSec: number, burst?: number) {
    this.ratePerSec = ratePerSec > 0 ? ratePerSec : 1;
    this.burst = burst && burst > 0 ? burst : Math.max(1, Math.ceil(this.ratePerSec));
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefill = now;
  }

  /**
   * Waits in a loop instead of sleeping once and taking the token regardless: a taker
   * that woke early used to keep the token and have its negative remainder clamped away,
   * which drifted the issued rate above the configured QPS over a long batch.
   */
  private async acquireOne(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      await sleep(Math.max(1, Math.ceil((deficit / this.ratePerSec) * 1000)));
    }
  }

  /** Estimated wait for a new taker given the current queue, in ms (0 when a token is free). */
  waitEstimateMs(): number {
    this.refill();
    const deficit = this.pending + 1 - this.tokens;
    return deficit <= 0 ? 0 : Math.ceil((deficit / this.ratePerSec) * 1000);
  }

  /** Resolves when a token is available. Callers are served in FIFO order. */
  async take(): Promise<void> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending += 1;
    await previous;
    try {
      await this.acquireOne();
    } finally {
      this.pending -= 1;
      release();
    }
  }
}

export class HostBusyError extends Error {
  constructor(host: string, waitedMs: number) {
    super(`host_busy: ${host} still saturated after ${waitedMs}ms`);
    this.name = 'HostBusyError';
  }
}

interface HostState {
  active: number;
  queue: Array<{ resolve: (release: () => void) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
}

export interface HostSemaphoreOptions {
  defaultLimit: number;
  tolerantHosts: string[];
  tolerantLimit: number;
  maxWaitMs: number;
}

export class HostSemaphore {
  private readonly hosts = new Map<string, HostState>();
  private readonly opts: HostSemaphoreOptions;

  constructor(opts: HostSemaphoreOptions) {
    this.opts = {
      ...opts,
      tolerantHosts: opts.tolerantHosts.map((h) => h.toLowerCase().replace(/^www\./, '')),
    };
  }

  private normalizeHost(host: string): string {
    return host.toLowerCase().replace(/^www\./, '');
  }

  limitFor(host: string): number {
    const h = this.normalizeHost(host);
    const tolerant = this.opts.tolerantHosts.some((t) => h === t || h.endsWith(`.${t}`));
    return tolerant ? this.opts.tolerantLimit : this.opts.defaultLimit;
  }

  /** Number of in-flight holders for a host (for tests and metrics). */
  activeFor(host: string): number {
    return this.hosts.get(this.normalizeHost(host))?.active ?? 0;
  }

  private state(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = { active: 0, queue: [] };
      this.hosts.set(host, state);
    }
    return state;
  }

  private makeRelease(host: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const state = this.state(host);
      state.active = Math.max(0, state.active - 1);
      this.dispatch(host, state);
    };
  }

  private dispatch(host: string, state: HostState): void {
    const limit = this.limitFor(host);
    while (state.active < limit && state.queue.length > 0) {
      const waiter = state.queue.shift()!;
      clearTimeout(waiter.timer);
      state.active += 1;
      waiter.resolve(this.makeRelease(host));
    }
    if (state.active === 0 && state.queue.length === 0) {
      this.hosts.delete(host);
    }
  }

  /** Resolves with a release function, or rejects with HostBusyError after maxWaitMs. */
  async acquire(rawHost: string): Promise<() => void> {
    const host = this.normalizeHost(rawHost);
    const state = this.state(host);
    if (state.active < this.limitFor(host)) {
      state.active += 1;
      return this.makeRelease(host);
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = state.queue.indexOf(waiter);
          if (idx !== -1) state.queue.splice(idx, 1);
          reject(new HostBusyError(host, this.opts.maxWaitMs));
        }, this.opts.maxWaitMs),
      };
      state.queue.push(waiter);
    });
  }
}

/**
 * HARD concurrency cap. The old version checked `active` once, so a caller entering
 * `run()` in the window between a release decrementing `active` and the woken waiter
 * incrementing it again could slip past the limit. The `while` re-checks after every wake.
 */
export class ConcurrencyCap {
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(readonly limit: number) {}

  /** In-flight holders (for tests and metrics). */
  get active(): number {
    return this.activeCount;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.activeCount >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.activeCount += 1;
    try {
      return await fn();
    } finally {
      this.activeCount -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export const NEWS_HOSTS = [
  'reuters.com',
  'bloomberg.com',
  'techcrunch.com',
  'prnewswire.com',
  'businesswire.com',
  'globenewswire.com',
  'forbes.com',
];

export const TOLERANT_HOSTS = ['linkedin.com', 'crunchbase.com', 'bing.com', ...NEWS_HOSTS];

const jinaRpm = envNumber('JINA_RPM', process.env['JINA_API_KEY'] ? 150 : 15);

export const serperBucket = new TokenBucket(envNumber('SERPER_QPS', 5));
export const jinaBucket = new TokenBucket(jinaRpm / 60, Math.max(1, Math.ceil(jinaRpm / 30)));
export const parseSemaphore: ConcurrencyCap = new ConcurrencyCap(
  Math.max(1, Math.floor(envNumber('PARSE_CONCURRENCY', 8)))
);
export const hostSemaphore = new HostSemaphore({
  defaultLimit: Math.floor(envNumber('HOST_LIMIT', 2)),
  tolerantHosts: TOLERANT_HOSTS,
  tolerantLimit: Math.floor(envNumber('HOST_TOLERANT_LIMIT', 8)),
  maxWaitMs: 5000,
});
