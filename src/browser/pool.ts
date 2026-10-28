import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { getRandomUserAgent, getRandomViewport, INIT_SCRIPTS } from './stealth.js';
import { nextStickyProxyUrl, rotatingProxyUrl, toPlaywrightProxy } from './proxy.js';

interface PoolEntry {
  context: BrowserContext;
  useCount: number;
  busy: boolean;
}

type Waiter = (ctx: BrowserContext) => void;

export const ACQUIRE_TIMEOUT_MS = 30_000;

export class BrowserPool {
  private browser: Browser | null = null;
  private pool: PoolEntry[] = [];
  private waitQueue: Waiter[] = [];
  private readonly poolSize: number;
  /** In-flight initialize(), so two concurrent callers cannot launch two browsers. */
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(poolSize: number = 3) {
    this.poolSize = poolSize;
  }

  /**
   * Serialised: `this.browser` is only assigned after `chromium.launch()` resolves, so
   * guarding on it let two concurrent callers each launch a Chromium and orphan one of
   * them. A FAILED init is not memoised - the next caller retries.
   */
  async initialize(): Promise<void> {
    if (this.poolSize <= 0 || this.browser) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initialize().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    if (this.poolSize <= 0 || this.browser) return;

    const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,800',
      ],
      headless: true,
    };

    if (executablePath) {
      launchOptions.executablePath = executablePath;
    }

    // Proxy is applied per context (sticky Webshare session per context), not per
    // browser. Chromium needs a placeholder launch proxy for per-context proxies to
    // take effect on every platform; it is never used because every context sets its own.
    if (rotatingProxyUrl()) {
      launchOptions.proxy = { server: 'http://per-context' };
    }

    const browser = await chromium.launch(launchOptions);
    if (this.closed) {
      await browser.close().catch(() => {});
      return;
    }
    this.browser = browser;

    // Pre-warm all contexts
    await Promise.all(
      Array.from({ length: this.poolSize }).map(async () => {
        const context = await this._createContext();
        this.pool.push({ context, useCount: 0, busy: false });
      })
    );
  }

  private async _createContext(): Promise<BrowserContext> {
    if (!this.browser) throw new Error('Browser not initialized');

    const ua = getRandomUserAgent();
    const viewport = getRandomViewport();

    const stickyProxy = nextStickyProxyUrl();
    const proxy = toPlaywrightProxy(stickyProxy);

    const context = await this.browser.newContext({
      userAgent: ua,
      viewport,
      locale: 'en-US',
      extraHTTPHeaders: {
        'accept-language': 'en-US,en;q=0.9',
      },
      ...(proxy ? { proxy } : {}),
    });

    // Webshare worked more reliably with plain Playwright than with stealth
    // patches. Keep the scripts only for non-proxy browsing.
    if (!proxy) {
      for (const script of INIT_SCRIPTS) {
        await context.addInitScript(script);
      }
    }

    return context;
  }

  async acquire(): Promise<BrowserContext> {
    if (this.poolSize <= 0 || this.pool.length === 0) {
      throw new Error('Browser pool unavailable: pool size is 0');
    }

    // Try to find a free context immediately
    const entry = this.pool.find((e) => !e.busy);
    if (entry) {
      entry.busy = true;
      return entry.context;
    }

    // All busy - wait up to 30 seconds.
    // The timeout must remove the WRAPPER that was queued, not `resolve`: removing the
    // wrong function object left the dead waiter queued, and the next dispatch marked a
    // context busy forever for a holder that had already rejected.
    return new Promise<BrowserContext>((resolve, reject) => {
      let settled = false;
      const waiter: Waiter = (ctx: BrowserContext) => {
        if (settled) {
          // Raced with the timeout: hand the context straight back so it is not stranded.
          this.release(ctx);
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(ctx);
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.waitQueue.indexOf(waiter);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(new Error(`Browser pool timeout: all contexts busy for ${ACQUIRE_TIMEOUT_MS}ms`));
      }, ACQUIRE_TIMEOUT_MS);

      this.waitQueue.push(waiter);
    });
  }

  release(context: BrowserContext): void {
    const entry = this.pool.find((e) => e.context === context);
    if (!entry) return;

    entry.useCount++;

    if (entry.useCount >= 50) {
      // Recycle: close this context and create a fresh one
      this._recycleEntry(entry);
    } else {
      entry.busy = false;
      this._dispatchToQueue(entry);
    }
  }

  /**
   * Discard a context immediately and replace with a fresh one.
   * Use this when a context has been contaminated (e.g., Google CAPTCHA cookies)
   * so it can't be reused for other sites.
   */
  discard(context: BrowserContext): void {
    const entry = this.pool.find((e) => e.context === context);
    if (!entry) return;
    this._recycleEntry(entry);
  }

  private _recycleEntry(entry: PoolEntry): void {
    entry.context.close().catch(() => {});
    this._createContext()
      .then((newCtx) => {
        entry.context = newCtx;
        entry.useCount = 0;
        entry.busy = false;
        this._dispatchToQueue(entry);
      })
      .catch(() => {
        // Creation failed: drop the entry for now, but schedule a regrow. Dropping it
        // permanently let a flaky proxy drain the pool to 0, after which every visit
        // reported `playwright_unavailable` for the life of the process.
        const idx = this.pool.indexOf(entry);
        if (idx !== -1) this.pool.splice(idx, 1);
        this.scheduleGrow();
      });
  }

  /** Test hook: how long to wait before retrying a failed context creation. */
  regrowDelayMs = 1_000;

  private growTimer: NodeJS.Timeout | null = null;
  private growing = false;

  private scheduleGrow(): void {
    if (this.closed || this.growTimer || this.growing) return;
    if (!this.browser || this.pool.length >= this.poolSize) return;
    this.growTimer = setTimeout(() => {
      this.growTimer = null;
      void this._grow();
    }, this.regrowDelayMs);
    this.growTimer.unref?.();
  }

  private async _grow(): Promise<void> {
    if (this.closed || this.growing || !this.browser) return;
    this.growing = true;
    try {
      while (!this.closed && this.browser && this.pool.length < this.poolSize) {
        const context = await this._createContext();
        const entry: PoolEntry = { context, useCount: 0, busy: false };
        this.pool.push(entry);
        this._dispatchToQueue(entry);
      }
    } catch {
      this.growing = false;
      this.scheduleGrow();
    } finally {
      this.growing = false;
    }
  }

  private _dispatchToQueue(entry: PoolEntry): void {
    if (this.waitQueue.length > 0 && !entry.busy) {
      const resolve = this.waitQueue.shift()!;
      entry.busy = true;
      resolve(entry.context);
    }
  }

  /**
   * Returns the number of contexts currently available (not busy).
   */
  get available(): number {
    return this.pool.filter((e) => !e.busy).length;
  }

  /**
   * Returns the total pool size (initialized contexts).
   */
  get size(): number {
    return this.pool.length;
  }

  /** Configured size from BROWSER_POOL_SIZE, whether or not initialize() has run. */
  get configuredSize(): number {
    return this.poolSize;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.growTimer) {
      clearTimeout(this.growTimer);
      this.growTimer = null;
    }
    this.waitQueue = [];
    await Promise.all(this.pool.map((e) => e.context.close().catch(() => {})));
    this.pool = [];
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

// Singleton - call initialize() explicitly at server start
// Pool size read from env directly to avoid circular config dependency at import time
const _poolSize = parseInt(process.env['BROWSER_POOL_SIZE'] ?? '3', 10);
export const browserPool = new BrowserPool(isNaN(_poolSize) ? 3 : _poolSize);
