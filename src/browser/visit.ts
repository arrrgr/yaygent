/**
 * Tiered page fetch with one total budget per visit:
 *   cache -> direct (5s) -> proxy x2 (5s each, only after 403/429/5xx/network/challenge)
 *   -> Jina Reader (8s) -> Serper scrape (8s, paid, only when SERPER_API_KEY is set)
 *   -> Playwright (only when jsRequired or everything failed, pool > 0).
 * Returns markdown (not pruned); pruning is the caller's job (`visitPage` does it
 * for the react loop).
 */
import type { BrowserContext, Page } from 'playwright';
import type { BrowserPool } from './pool.js';
import { getRandomUserAgent } from './stealth.js';
import { httpFetch, BodyTooLargeError } from './http.js';
import { htmlToMarkdown, cleanMarkdown, looksLikeChallenge, looksLikeInterstitial, pruneForQuestion } from './prune.js';
import { LruCache } from './lru.js';
import { rotatingProxyUrl } from './proxy.js';
import { hostSemaphore, jinaBucket, parseSemaphore, HostBusyError } from '../limits.js';

export interface PageCacheEntry {
  url_norm: string;
  url_final: string;
  status: number;
  tier: string;
  bytes: number;
  markdown: string;
  fetched_at: string;
}

export interface PageCacheHook {
  get(urlNorm: string): Promise<PageCacheEntry | null>;
  set(entry: PageCacheEntry): void;
}

export interface FetchOptions {
  question?: string;
  budgetMs?: number;
  jsRequired?: boolean;
  cache?: PageCacheHook;
  /** Optional pool for the Playwright tier; defaults to the process singleton. */
  pool?: BrowserPool;
}

export type FetchTier = 'cache' | 'direct' | 'proxy' | 'jina' | 'serper' | 'playwright' | 'none';

export interface FetchResult {
  ok: boolean;
  markdown: string;
  tier: FetchTier;
  status: number;
  bytes: number;
  url_final: string;
  cached: boolean;
  error?: string;
  tiers_tried: string[];
  bytes_by_tier: Record<string, number>;
  elapsed_ms: number;
}

type TierName = 'direct' | 'proxy' | 'jina' | 'serper' | 'playwright';

const DEFAULT_BUDGET_MS = 20_000;
const TIER_MS: Record<TierName, number> = { direct: 5_000, proxy: 5_000, jina: 8_000, serper: 8_000, playwright: 10_000 };
const MIN_TIER_MS = 1_500;
const PROXY_ATTEMPTS = 2;
const DEFAULT_MIN_CONTENT_CHARS = 120;
const MIN_CACHE_CHARS = 500;
/** Tiers that hold a per-host concurrency slot; Jina uses its own IPs and holds none. */
const SEMAPHORE_TIERS = new Set<TierName>(['direct', 'proxy', 'playwright']);
const PAGE_LRU_ENTRIES = 2_000;
const PAGE_LRU_TTL_MS = 60 * 60 * 1000;
const JINA_BASE = 'https://r.jina.ai/';
const SERPER_SCRAPE_URL = 'https://scrape.serper.dev';
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'msclkid', 'yclid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'igshid']);
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

/** Injectable clock so tests can simulate elapsed budget without sleeping. */
export const _clock = { now: () => Date.now() };

const pageLru = new LruCache<PageCacheEntry>(PAGE_LRU_ENTRIES, PAGE_LRU_TTL_MS);

/** Test hook: clear the in-process page cache. */
export function _clearPageCache(): void {
  pageLru.clear();
}

function envBudgetMs(): number {
  const raw = Number(process.env['FETCH_BUDGET_MS'] ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_MS;
}

function configuredPoolSize(): number {
  const raw = parseInt(process.env['BROWSER_POOL_SIZE'] ?? '3', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function minContentChars(): number {
  const raw = Number(process.env['MIN_CONTENT_CHARS'] ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_CONTENT_CHARS;
}

export class BlockedHostError extends Error {
  constructor(host: string) {
    super(`blocked_host: ${host}`);
    this.name = 'BlockedHostError';
  }
}

function ipv4Blocked(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * SSRF guard. `fetchPage` takes its URL from caller-supplied row data, so a private,
 * loopback, link-local or `*.internal` host must never be requested at all.
 */
export function isBlockedFetchHost(hostname: string): boolean {
  const host = (hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.localdomain')) return true;
  if (host === 'metadata.google.internal') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    return ipv4Blocked(parts[0], parts[1]);
  }
  if (host.includes(':')) {
    // IPv6 literal: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10)
    if (host === '::1' || host === '::') return true;
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mapped) return isBlockedFetchHost(mapped[1]);
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;
    return false;
  }
  // A bare label with no dot is an intranet name, not a public site.
  if (!host.includes('.')) return true;
  return false;
}

export function normalizeUrl(url: string): string {
  let raw = (url ?? '').trim();
  if (!raw) throw new Error('empty url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  const u = new URL(raw);
  if (u.protocol === 'http:') {
    u.protocol = 'https:';
    if (u.port === '80') u.port = '';
  }
  if (u.port === '443') u.port = '';
  u.hostname = u.hostname.toLowerCase();
  if (isBlockedFetchHost(u.hostname)) throw new BlockedHostError(u.hostname);

  // A hash ROUTE is part of the address on a hash-routed SPA; a plain fragment is not.
  const hash = u.hash.startsWith('#/') ? u.hash : '';

  // Rebuild the query by hand: searchParams re-serialisation turns %20 into +.
  let query = '';
  if (u.search.length > 1) {
    const kept = u.search
      .slice(1)
      .split('&')
      .filter((pair) => {
        if (!pair) return false;
        let key = pair.split('=')[0] ?? '';
        try {
          key = decodeURIComponent(key);
        } catch {
          // keep the raw key
        }
        const lower = key.toLowerCase();
        return !(lower.startsWith('utm_') || TRACKING_PARAMS.has(lower));
      });
    if (kept.length > 0) query = `?${kept.join('&')}`;
  }

  let path = u.pathname.replace(/\/+$/, '');
  if (!path && hash) path = '/';
  return `${u.protocol}//${u.host}${path}${query}${hash}`;
}

export function isLinkedInProfileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (host === 'linkedin.com' || host.endsWith('.linkedin.com')) && /^\/in\//i.test(u.pathname);
  } catch {
    return false;
  }
}

type TierOutcome =
  | { kind: 'success'; markdown: string; status: number; bytes: number; url_final: string; html?: string }
  | { kind: 'escalate' | 'thin' | 'stop'; error: string; status: number; bytes: number }
  | { kind: 'host_busy'; error: string; status: 0; bytes: 0 };

function isHtmlContentType(contentType: string): boolean {
  return !contentType || /text\/html|application\/xhtml|text\/plain|application\/xml|text\/xml/i.test(contentType);
}

function classifyStatus(status: number): 'ok' | 'escalate' | 'stop' {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 403 || status === 429 || status >= 500 || status === 0) return 'escalate';
  return 'stop';
}

async function toMarkdown(body: string, contentType: string, url: string): Promise<{ markdown: string; html?: string }> {
  if (/text\/plain/i.test(contentType)) {
    return { markdown: cleanMarkdown(body) };
  }
  const markdown = await parseSemaphore.run(async () => htmlToMarkdown(body, url));
  return { markdown, html: body };
}

function bareHostKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

async function httpTier(
  tier: 'direct' | 'proxy',
  url: string,
  timeoutMs: number,
  proxyUrl?: string,
  remainingMs?: () => number
): Promise<TierOutcome> {
  const host = new URL(url).hostname;
  const waitStarted = _clock.now();
  let release: () => void;
  try {
    release = await hostSemaphore.acquire(host);
  } catch (err) {
    if (err instanceof HostBusyError) return { kind: 'host_busy', error: 'host_busy', status: 0, bytes: 0 };
    return { kind: 'escalate', error: `host_semaphore: ${(err as Error).message}`, status: 0, bytes: 0 };
  }

  try {
    // The semaphore wait (up to 5s) is part of the visit budget, not free time on top of it.
    const waited = Math.max(0, _clock.now() - waitStarted);
    const left = remainingMs ? remainingMs() : timeoutMs;
    const effectiveTimeout = Math.min(timeoutMs - waited, left);
    if (effectiveTimeout < MIN_TIER_MS) {
      return { kind: 'escalate', error: `budget_after_host_wait (${waited}ms waited)`, status: 0, bytes: 0 };
    }

    const response = await httpFetch(url, {
      timeoutMs: effectiveTimeout,
      proxyUrl,
      headers: {
        'User-Agent': getRandomUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const { status, body, bytes, contentType } = response;
    const finalUrl = response.url || url;

    // Redirects: the LinkedIn block and the host semaphore were only ever applied to the
    // REQUESTED host, so a 302 walked straight through both.
    let finalHost = host;
    if (finalUrl !== url) {
      if (isLinkedInProfileUrl(finalUrl)) {
        return { kind: 'stop', error: 'linkedin_blocked (redirect)', status, bytes };
      }
      try {
        finalHost = new URL(finalUrl).hostname;
      } catch {
        finalHost = host;
      }
      if (isBlockedFetchHost(finalHost)) {
        return { kind: 'stop', error: 'blocked_host (redirect)', status, bytes };
      }
    }

    const parse = async (): Promise<TierOutcome> => {
      if (looksLikeChallenge(body, status)) {
        return { kind: 'escalate', error: `challenge (http ${status})`, status, bytes };
      }
      const cls = classifyStatus(status);
      if (cls === 'escalate') return { kind: 'escalate', error: `http_${status}`, status, bytes };
      if (cls === 'stop') return { kind: 'stop', error: `http_${status}`, status, bytes };
      if (!isHtmlContentType(contentType)) {
        return { kind: 'thin', error: `unsupported_content_type: ${contentType.split(';')[0]}`, status, bytes };
      }
      const { markdown, html } = await toMarkdown(body, contentType, finalUrl);
      if (looksLikeInterstitial(bytes, markdown.length)) {
        // big payload, almost no text: a JS challenge, a redirect shim or an empty SPA shell
        return { kind: 'escalate', error: `interstitial (${bytes} bytes, ${markdown.length} chars)`, status, bytes };
      }
      if (markdown.length < minContentChars()) {
        return { kind: 'thin', error: `thin_content (${markdown.length} chars)`, status, bytes };
      }
      return { kind: 'success', markdown, status, bytes, url_final: finalUrl, html };
    };

    if (bareHostKey(finalHost) === bareHostKey(host)) return parse();

    // Charge the redirect target's own host slot for the rest of this visit.
    let releaseFinal: () => void;
    try {
      releaseFinal = await hostSemaphore.acquire(finalHost);
    } catch (err) {
      if (err instanceof HostBusyError) return { kind: 'host_busy', error: 'host_busy', status: 0, bytes: 0 };
      return { kind: 'escalate', error: `host_semaphore: ${(err as Error).message}`, status: 0, bytes: 0 };
    }
    try {
      return await parse();
    } finally {
      releaseFinal();
    }
  } catch (err) {
    // A page over the body cap must ESCALATE (Jina returns markdown and never ships us
    // the 1.5MB), not stop the whole visit.
    if (err instanceof BodyTooLargeError) return { kind: 'escalate', error: 'body_too_large', status: 0, bytes: 0 };
    return { kind: 'escalate', error: (err as Error).message || String(err), status: 0, bytes: 0 };
  } finally {
    release();
  }
}

async function jinaTier(url: string, timeoutMs: number): Promise<TierOutcome> {
  const headers: Record<string, string> = {
    Accept: 'text/plain',
    'X-Return-Format': 'markdown',
    'User-Agent': getRandomUserAgent(),
  };
  const key = process.env['JINA_API_KEY']?.trim();
  if (key) headers['Authorization'] = `Bearer ${key}`;

  try {
    const response = await httpFetch(`${JINA_BASE}${url}`, { timeoutMs, headers });
    const { status, body, bytes } = response;
    if (status < 200 || status >= 300) {
      return { kind: 'escalate', error: `jina_http_${status}`, status, bytes };
    }
    if (looksLikeChallenge(body, status)) {
      return { kind: 'escalate', error: 'jina_challenge', status, bytes };
    }
    const markdown = cleanMarkdown(body);
    if (markdown.length < minContentChars()) {
      return { kind: 'thin', error: `jina_thin_content (${markdown.length} chars)`, status, bytes };
    }
    return { kind: 'success', markdown, status, bytes, url_final: url };
  } catch (err) {
    if (err instanceof BodyTooLargeError) return { kind: 'escalate', error: 'body_too_large', status: 0, bytes: 0 };
    return { kind: 'escalate', error: (err as Error).message || String(err), status: 0, bytes: 0 };
  }
}

/**
 * Serper's page scrape: fetches from its own infrastructure, so it gets through the bot
 * walls and datacenter-IP blocks that stop direct/proxy, and it is the fallback when Jina
 * fails or is rate-limited. Paid per call (2-10 credits), so it runs after Jina.
 */
async function serperTier(url: string, timeoutMs: number): Promise<TierOutcome> {
  const apiKey = process.env['SERPER_API_KEY']?.trim();
  if (!apiKey) return { kind: 'escalate', error: 'serper_no_key', status: 0, bytes: 0 };
  try {
    const response = await httpFetch(SERPER_SCRAPE_URL, {
      timeoutMs,
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, includeMarkdown: true }),
    });
    const { status, body, bytes } = response;
    if (status < 200 || status >= 300) {
      return { kind: 'escalate', error: `serper_http_${status}`, status, bytes };
    }
    let parsed: { markdown?: string; text?: string };
    try {
      parsed = JSON.parse(body) as { markdown?: string; text?: string };
    } catch {
      return { kind: 'escalate', error: 'serper_bad_json', status, bytes };
    }
    const raw = parsed.markdown || parsed.text || '';
    if (looksLikeChallenge(raw, status)) {
      return { kind: 'escalate', error: 'serper_challenge', status, bytes };
    }
    const markdown = cleanMarkdown(raw);
    if (markdown.length < minContentChars()) {
      return { kind: 'thin', error: `serper_thin_content (${markdown.length} chars)`, status, bytes };
    }
    return { kind: 'success', markdown, status, bytes, url_final: url };
  } catch (err) {
    if (err instanceof BodyTooLargeError) return { kind: 'escalate', error: 'body_too_large', status: 0, bytes: 0 };
    return { kind: 'escalate', error: (err as Error).message || String(err), status: 0, bytes: 0 };
  }
}

let poolInit: Promise<BrowserPool> | null = null;

/** A FAILED init is never memoised: one transient launch failure used to disable Playwright forever. */
async function getPool(explicit?: BrowserPool): Promise<BrowserPool> {
  if (explicit) {
    if (explicit.size === 0 && explicit.configuredSize > 0) await explicit.initialize();
    return explicit;
  }
  if (!poolInit) {
    poolInit = import('./pool.js')
      .then(async ({ browserPool }) => {
        await browserPool.initialize();
        return browserPool;
      })
      .catch((err) => {
        poolInit = null;
        throw err;
      });
  }
  return poolInit;
}

/** Test hook: forget the memoised singleton pool. */
export function _resetPoolInit(): void {
  poolInit = null;
}

/**
 * Everything that can throw lives inside the try, so the host slot is always released
 * and the pool context is never stranded. Previously `pool.acquire()`/`newPage()` ran
 * outside it: one throwing acquire leaked a host slot permanently AND made `fetchPage`
 * reject, which no caller expects.
 */
async function playwrightTier(url: string, timeoutMs: number, explicitPool?: BrowserPool): Promise<TierOutcome> {
  const host = new URL(url).hostname;
  const waitStarted = _clock.now();
  let release: () => void;
  try {
    release = await hostSemaphore.acquire(host);
  } catch (err) {
    if (err instanceof HostBusyError) return { kind: 'host_busy', error: 'host_busy', status: 0, bytes: 0 };
    return { kind: 'escalate', error: `host_semaphore: ${(err as Error).message}`, status: 0, bytes: 0 };
  }

  let pool: BrowserPool | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const usingProxy = Boolean(rotatingProxyUrl());

  try {
    const waited = Math.max(0, _clock.now() - waitStarted);
    const effectiveTimeout = timeoutMs - waited;
    if (effectiveTimeout < MIN_TIER_MS) {
      return { kind: 'escalate', error: `budget_after_host_wait (${waited}ms waited)`, status: 0, bytes: 0 };
    }

    try {
      pool = await getPool(explicitPool);
    } catch (err) {
      return { kind: 'escalate', error: `playwright_init: ${(err as Error).message}`, status: 0, bytes: 0 };
    }
    if (pool.size === 0) {
      return { kind: 'escalate', error: 'playwright_unavailable', status: 0, bytes: 0 };
    }

    context = await pool.acquire();
    page = await context.newPage();

    await page.route('**/*', (route) => {
      if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: effectiveTimeout });
    const status = response?.status() ?? 200;
    const finalUrl = page.url();
    if (finalUrl !== url && isLinkedInProfileUrl(finalUrl)) {
      return { kind: 'stop', error: 'linkedin_blocked (redirect)', status, bytes: 0 };
    }
    const html = await page.content();
    const bytes = Buffer.byteLength(html, 'utf8');
    if (looksLikeChallenge(html, status)) {
      return { kind: 'escalate', error: `playwright_challenge (http ${status})`, status, bytes };
    }
    if (classifyStatus(status) !== 'ok') {
      return { kind: 'escalate', error: `playwright_http_${status}`, status, bytes };
    }
    const markdown = await parseSemaphore.run(async () => htmlToMarkdown(html, finalUrl));
    if (markdown.length < minContentChars()) {
      return { kind: 'thin', error: `playwright_thin_content (${markdown.length} chars)`, status, bytes };
    }
    return { kind: 'success', markdown, status, bytes, url_final: finalUrl, html };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return { kind: 'escalate', error: /timeout/i.test(msg) ? 'playwright_timeout' : `playwright: ${msg}`, status: 0, bytes: 0 };
  } finally {
    if (page) await page.close().catch(() => {});
    if (pool && context) {
      // One sticky proxy session per page: discard the context so the next one gets a new
      // session. A context whose page never opened is discarded too, never released dirty.
      if (usingProxy || !page) {
        try {
          pool.discard(context);
        } catch {
          // pool is shutting down
        }
      } else {
        try {
          pool.release(context);
        } catch {
          // pool is shutting down
        }
      }
    }
    release();
  }
}

interface InternalResult {
  result: FetchResult;
  html?: string;
}

function entryToResult(entry: PageCacheEntry, tiersTried: string[], elapsed: number): FetchResult {
  return {
    ok: true,
    markdown: entry.markdown,
    tier: 'cache',
    status: entry.status,
    bytes: entry.bytes,
    url_final: entry.url_final,
    cached: true,
    tiers_tried: tiersTried,
    bytes_by_tier: {},
    elapsed_ms: elapsed,
  };
}

function storeInCaches(entry: PageCacheEntry, hook?: PageCacheHook): void {
  if (entry.status >= 400 || entry.markdown.length < MIN_CACHE_CHARS) return;
  pageLru.set(entry.url_norm, entry);
  if (!hook) return;
  try {
    const maybe = hook.set(entry) as unknown;
    if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
      (maybe as Promise<void>).catch((err) => console.warn('[visit] cache set failed:', (err as Error).message));
    }
  } catch (err) {
    console.warn('[visit] cache set failed:', (err as Error).message);
  }
}

async function fetchPageInternal(url: string, opts: FetchOptions = {}): Promise<InternalResult> {
  const started = _clock.now();
  const budget = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : envBudgetMs();
  const remaining = () => budget - (_clock.now() - started);
  const tiersTried: string[] = [];
  const bytesByTier: Record<string, number> = {};

  const fail = (error: string, status = 0, urlFinal = url): InternalResult => ({
    result: {
      ok: false,
      markdown: '',
      tier: 'none',
      status,
      bytes: 0,
      url_final: urlFinal,
      cached: false,
      error,
      tiers_tried: tiersTried,
      bytes_by_tier: bytesByTier,
      elapsed_ms: _clock.now() - started,
    },
  });

  let urlNorm: string;
  try {
    urlNorm = normalizeUrl(url);
  } catch (err) {
    if (err instanceof BlockedHostError) return fail('blocked_host');
    return fail('invalid_url');
  }
  if (isLinkedInProfileUrl(urlNorm)) {
    return fail('linkedin_blocked', 0, urlNorm);
  }

  const lruHit = pageLru.get(urlNorm);
  if (lruHit) return { result: entryToResult(lruHit, tiersTried, _clock.now() - started) };
  if (opts.cache) {
    tiersTried.push('cache');
    try {
      const entry = await opts.cache.get(urlNorm);
      if (entry && entry.markdown && entry.markdown.length >= MIN_CACHE_CHARS) {
        pageLru.set(urlNorm, entry);
        return { result: entryToResult(entry, tiersTried, _clock.now() - started) };
      }
    } catch (err) {
      console.warn('[visit] cache get failed:', (err as Error).message);
    }
  }

  const proxyUrl = rotatingProxyUrl();
  const order: TierName[] = opts.jsRequired
    ? ['playwright', 'jina', 'serper', 'direct', 'proxy']
    : ['direct', 'proxy', 'jina', 'serper', 'playwright'];
  const serperEligible = Boolean(process.env['SERPER_API_KEY']?.trim());

  let proxyEligible = false;
  let hostBusy = false;
  let lastError = 'no_tier_ran';
  let lastStatus = 0;

  const eligible = (tier: TierName): boolean => {
    if (hostBusy && SEMAPHORE_TIERS.has(tier)) return false;
    if (tier === 'proxy') return proxyEligible && Boolean(proxyUrl);
    if (tier === 'serper') return serperEligible;
    if (tier === 'playwright') return (opts.pool ? opts.pool.configuredSize : configuredPoolSize()) > 0;
    return true;
  };
  const laterTiers = (tier: TierName): TierName[] => order.slice(order.indexOf(tier) + 1).filter(eligible);

  /**
   * The ladder does not fit its own budget at full tier timeouts (5+5+5+8+10 = 33s against
   * 15s), which is why Jina used to be skipped on every escalation. A tier may therefore
   * run on a REDUCED timeout, but only when nothing behind it could use the time better.
   */
  const fitsBudget = (tier: TierName): boolean => {
    const rem = remaining();
    if (rem >= TIER_MS[tier]) return true;
    if (rem < MIN_TIER_MS) return false;
    return !laterTiers(tier).some((later) => rem >= TIER_MS[later]);
  };

  /** A repeat attempt of the same tier must leave the next tier its full slice. */
  const fitsRepeatAttempt = (tier: TierName): boolean => {
    const next = laterTiers(tier)[0];
    const reserve = next ? TIER_MS[next] : 0;
    return remaining() >= TIER_MS[tier] + reserve;
  };

  for (const tier of order) {
    if (hostBusy && SEMAPHORE_TIERS.has(tier)) {
      lastError = `${lastError}; ${tier} skipped (host_busy)`;
      continue;
    }
    if (tier === 'proxy' && (!proxyEligible || !proxyUrl)) continue;
    if (tier === 'serper' && !serperEligible) continue;
    if (tier === 'playwright' && (opts.pool ? opts.pool.configuredSize : configuredPoolSize()) <= 0) continue;
    if (!fitsBudget(tier)) {
      lastError = `${lastError}; ${tier} skipped (budget)`;
      continue;
    }
    const attempts = tier === 'proxy' ? PROXY_ATTEMPTS : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt === 0 ? !fitsBudget(tier) : !fitsRepeatAttempt(tier)) {
        if (attempt > 0) lastError = `${lastError}; ${tier} attempt ${attempt + 1} skipped (budget reserved for next tier)`;
        break;
      }
      if (tier === 'jina') {
        if (jinaBucket.waitEstimateMs() > remaining() - MIN_TIER_MS) {
          lastError = `${lastError}; jina skipped (rate limit queue)`;
          break;
        }
        await jinaBucket.take();
        if (remaining() < MIN_TIER_MS) {
          lastError = `${lastError}; jina skipped (budget after rate limit)`;
          break;
        }
      }
      const timeoutMs = Math.min(TIER_MS[tier], remaining());
      tiersTried.push(tier);

      // A tier must never take the whole visit down with it: fetchPage always resolves.
      let outcome: TierOutcome;
      try {
        outcome =
          tier === 'direct' ? await httpTier('direct', urlNorm, timeoutMs, undefined, remaining)
          : tier === 'proxy' ? await httpTier('proxy', urlNorm, timeoutMs, proxyUrl, remaining)
          : tier === 'jina' ? await jinaTier(urlNorm, timeoutMs)
          : tier === 'serper' ? await serperTier(urlNorm, timeoutMs)
          : await playwrightTier(urlNorm, timeoutMs, opts.pool);
      } catch (err) {
        outcome = { kind: 'escalate', error: `${tier}_error: ${(err as Error).message || String(err)}`, status: 0, bytes: 0 };
      }

      bytesByTier[tier] = (bytesByTier[tier] ?? 0) + outcome.bytes;

      if (outcome.kind === 'success') {
        console.info(`[visit] ${tier} ok for ${urlNorm} (${outcome.markdown.length} chars, ${outcome.bytes} bytes)`);
        const entry: PageCacheEntry = {
          url_norm: urlNorm,
          url_final: outcome.url_final,
          status: outcome.status,
          tier,
          bytes: outcome.bytes,
          markdown: outcome.markdown,
          fetched_at: new Date().toISOString(),
        };
        storeInCaches(entry, opts.cache);
        return {
          html: outcome.html,
          result: {
            ok: true,
            markdown: outcome.markdown,
            tier,
            status: outcome.status,
            bytes: outcome.bytes,
            url_final: outcome.url_final,
            cached: false,
            tiers_tried: tiersTried,
            bytes_by_tier: bytesByTier,
            elapsed_ms: _clock.now() - started,
          },
        };
      }

      if (outcome.kind === 'host_busy') {
        // Only the semaphore-gated tiers are blocked. Jina holds no host slot and is
        // exactly the tier that should still run (design 2.2).
        console.warn(`[visit] host busy for ${urlNorm}, skipping semaphore-gated tiers`);
        hostBusy = true;
        lastError = 'host_busy';
        break;
      }

      lastError = outcome.error;
      lastStatus = outcome.status;
      console.warn(`[visit] ${tier} failed for ${urlNorm}: ${outcome.error}`);

      if (outcome.kind === 'stop') {
        return fail(outcome.error, outcome.status, urlNorm);
      }
      if (tier === 'direct' && outcome.kind === 'escalate') proxyEligible = true;
      if (outcome.kind === 'thin') break;
    }
  }

  return fail(lastError, lastStatus, urlNorm);
}

function hardFailure(url: string, error: string): FetchResult {
  return {
    ok: false,
    markdown: '',
    tier: 'none',
    status: 0,
    bytes: 0,
    url_final: url,
    cached: false,
    error,
    tiers_tried: [],
    bytes_by_tier: {},
    elapsed_ms: 0,
  };
}

/** Contract: this NEVER rejects. Every caller expects a FetchResult, not a throw. */
export async function fetchPage(url: string, opts?: FetchOptions): Promise<FetchResult> {
  try {
    const { result } = await fetchPageInternal(url, opts);
    return result;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    console.warn(`[visit] fetchPage failed hard for ${url}: ${msg}`);
    return hardFailure(url, `fetch_failed: ${msg}`);
  }
}

interface Anchor {
  href: string;
  text: string;
}

function extractAnchors(content: string): Anchor[] {
  const anchors: Anchor[] = [];
  if (/<a\b[^>]*href/i.test(content)) {
    const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      anchors.push({ href: match[1].trim(), text: match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
    }
  } else {
    const pattern = /\[([^\]]*)\]\(([^)\s]+)(?:\s[^)]*)?\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      anchors.push({ href: match[2].trim(), text: match[1].replace(/\s+/g, ' ').trim() });
    }
  }
  return anchors;
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/** Sections whose pages are articles about a topic, not the topic page itself. */
const PATH_SECTION_PREFIXES = new Set([
  'blog', 'news', 'press', 'legal', 'docs', 'doc', 'support', 'help', 'category', 'categories',
  'tag', 'tags', 'post', 'posts', 'article', 'articles', 'event', 'events', 'resource',
  'resources', 'case-studies', 'jobs', 'careers', 'search', 'wp-content', 'shop', 'store',
]);
/** A slug carrying one of these is boilerplate whatever else it matches. */
const PATH_REJECT_TOKENS = new Set([
  'cookie', 'cookies', 'privacy', 'policy', 'policies', 'terms', 'legal', 'gdpr', 'imprint',
  'disclaimer', 'sitemap', 'login', 'signin', 'signup', 'register', 'cart', 'checkout', 'rss',
]);
const MAX_SLUG_TOKENS = 3;

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Matches follow words on path SEGMENTS and anchor-text WORDS, in the priority order of
 * the `follow` list. Substring matching on the whole path used to pick `/our-history` for
 * `story` and `/blog/about-our-series-a` for `about`, and document order beat priority.
 */
export function pickFollowLink(content: string, baseUrl: string, follow: string[]): string | undefined {
  const words = follow.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
  if (words.length === 0) return undefined;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const baseHost = bareHost(base.hostname);

  interface Candidate {
    url: string;
    slugTokens: string[];
    textTokens: string[];
    usable: boolean;
  }
  const candidates: Candidate[] = [];

  for (const anchor of extractAnchors(content)) {
    if (!anchor.href || /^(#|mailto:|tel:|javascript:|data:)/i.test(anchor.href)) continue;
    let target: URL;
    try {
      target = new URL(anchor.href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(target.protocol)) continue;
    const host = bareHost(target.hostname);
    if (host !== baseHost && !host.endsWith(`.${baseHost}`)) continue;
    const path = target.pathname.replace(/\/+$/, '');
    if (!path) continue;

    const segments = path.split('/').filter(Boolean);
    const slug = segments[segments.length - 1] ?? '';
    const slugTokens = tokenize(slug);
    const allTokens = segments.flatMap(tokenize);
    const inSection = segments.slice(0, -1).some((seg) => PATH_SECTION_PREFIXES.has(seg.toLowerCase()));
    const rejected = allTokens.some((t) => PATH_REJECT_TOKENS.has(t));
    const usable = !inSection && !rejected && slugTokens.length > 0 && slugTokens.length <= MAX_SLUG_TOKENS;

    target.hash = '';
    candidates.push({ url: target.toString(), slugTokens, textTokens: tokenize(anchor.text), usable });
  }

  for (const word of words) {
    for (const candidate of candidates) {
      if (!candidate.usable) continue;
      if (candidate.slugTokens.includes(word) || candidate.textTokens.includes(word)) return candidate.url;
    }
  }
  return undefined;
}

/** Fetch the homepage, follow the first matching internal anchor (about/team/...), fetch that page. */
export async function discoverAndFetch(
  fromUrl: string,
  follow: string[],
  opts?: FetchOptions
): Promise<FetchResult & { discovered_url?: string }> {
  const started = _clock.now();
  const budget = opts?.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : envBudgetMs();
  let home: InternalResult;
  try {
    home = await fetchPageInternal(fromUrl, { ...opts, budgetMs: budget });
  } catch (err) {
    return hardFailure(fromUrl, `fetch_failed: ${(err as Error).message || String(err)}`);
  }
  if (!home.result.ok) return home.result;

  let homeBase = home.result.url_final;
  if (!homeBase) {
    try {
      homeBase = normalizeUrl(fromUrl);
    } catch {
      return home.result;
    }
  }
  const discovered = pickFollowLink(home.html ?? home.result.markdown, homeBase, follow);
  if (!discovered) return home.result;

  let homeNorm = '';
  let discoveredNorm = '';
  try {
    homeNorm = normalizeUrl(home.result.url_final || fromUrl);
    discoveredNorm = normalizeUrl(discovered);
  } catch {
    return home.result;
  }
  if (discoveredNorm === homeNorm) return home.result;

  // ONE total budget per visit (design 2.2). The second fetch gets what the homepage
  // left; when the homepage ate the budget the homepage result IS the answer.
  const secondBudget = budget - (_clock.now() - started);
  const mergedBytes = { ...home.result.bytes_by_tier };
  if (secondBudget < MIN_TIER_MS) {
    console.warn(`[visit] no budget left for the discovered page, returning homepage for ${fromUrl}`);
    return { ...home.result, discovered_url: discovered, error: 'discovered_fetch_skipped (budget)' };
  }

  const page = await fetchPage(discovered, { ...opts, budgetMs: secondBudget });
  for (const [tier, bytes] of Object.entries(page.bytes_by_tier)) {
    mergedBytes[tier] = (mergedBytes[tier] ?? 0) + bytes;
  }
  if (page.ok) {
    return {
      ...page,
      discovered_url: discovered,
      tiers_tried: [...home.result.tiers_tried, ...page.tiers_tried],
      bytes_by_tier: mergedBytes,
      elapsed_ms: _clock.now() - started,
    };
  }
  console.warn(`[visit] discovered page failed (${page.error}), returning homepage for ${fromUrl}`);
  return {
    ...home.result,
    discovered_url: discovered,
    bytes_by_tier: mergedBytes,
    error: `discovered_fetch_failed: ${page.error}`,
  };
}

/** React-loop entry point: fetch + prune, text out (error text on failure like before). */
export async function visitPage(url: string, pool: BrowserPool, question?: string): Promise<string> {
  const result = await fetchPage(url, { question, pool });
  if (!result.ok) {
    return `[Page not accessible: ${url}] (${result.error ?? 'unknown error'})`;
  }
  return pruneForQuestion(result.markdown, question);
}
