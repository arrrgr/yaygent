/**
 * Search layer: Serper (bought Google) first, then Google News RSS for news
 * queries or Bing HTML over the rotating proxy when Serper fails.
 * Google over proxies never returns a SERP in the observed deployment environment,
 * so there is no scraped-Google path here any more.
 */
import { JSDOM } from 'jsdom';
import type { BrowserPool } from './pool.js';
import { httpFetch } from './http.js';
import { LruCache } from './lru.js';
import { rotatingProxyUrl } from './proxy.js';
import { parseSemaphore, serperBucket } from '../limits.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  position: number;
  source: 'serper' | 'serper_news' | 'google_news_rss' | 'bing_proxy';
}

export interface SearchOptions {
  gl?: string;
  hl?: string;
  num?: number;
  type?: 'web' | 'news';
  recency?: '1d' | '1w' | '1m' | '6m' | '1y';
}

const SERPER_TIMEOUT_MS = 8_000;
const NEWS_RSS_TIMEOUT_MS = 5_000;
const BING_TIMEOUT_MS = 6_000;
const SERPER_BACKOFF_MS = [2_000, 4_000];
// ONE default for both call shapes: the legacy shape defaulted to 5 and the new one to
// 10, and `num` is part of the cache key, so the same query was bought twice.
const DEFAULT_NUM = 10;

const TBS_BY_RECENCY: Record<NonNullable<SearchOptions['recency']>, string> = {
  '1d': 'qdr:d',
  '1w': 'qdr:w',
  '1m': 'qdr:m',
  '6m': 'qdr:m6',
  '1y': 'qdr:y',
};

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Unambiguous legal suffixes: stripping one of these never removes a name word.
 * `group`, `co`, `as`, `ab`, `sa`, `lp`, `kg` are NOT here - they are real name words
 * often enough ("The Carlyle Group", "Co-op Group") that blanket stripping broke the
 * anchored phrase. They are handled by MINIMUM_CORE_WORDS below instead.
 */
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'gmbh', 'corp', 'corporation', 'company',
  'plc', 'ag', 'srl', 'bv', 'nv', 'pty', 'llp', 'holdings', 'oy',
]);
/** Weak suffixes: stripped only when at least two words remain after the strip. */
const WEAK_SUFFIXES = new Set(['group', 'co', 'sa', 'as', 'ab', 'lp', 'kg', 'und']);
/** A connector left dangling by a strip is never the end of a name. */
const DANGLING_CONNECTORS = new Set(['and', 'und', 'the', 'of']);
const LEGAL_SUFFIX_PHRASES = [/\bgroup of companies$/i, /\bof companies$/i, /\bholding company$/i];

const cache = new LruCache<SearchResult[]>(5_000, 60 * 60 * 1000);
let warnedMissingSerperKey = false;

/** Words that carry no identity of their own when counting what a name has left. */
function meaningfulWords(words: string[]): string[] {
  return words.filter((w) => !DANGLING_CONNECTORS.has(w.toLowerCase()));
}

/**
 * Strip quotes, punctuation and trailing legal suffixes so the value is safe inside a
 * quoted phrase. An intercap ampersand becomes ` and ` and is never collapsed:
 * `AT&T -> ATT` and `H&M -> HM` matched nothing on Google. A weak suffix (`group`, `co`)
 * is only stripped when two meaningful words survive it, so `The Carlyle Group` keeps its
 * last word instead of anchoring on the single generic word `Carlyle`.
 */
export function sanitizeQueryValue(v: string): string {
  let value = (v ?? '')
    .replace(/["'“”‘’`]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[|\\/()[\]{}<>:;,.!?*+^~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return '';

  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of LEGAL_SUFFIX_PHRASES) {
      const next = value.replace(phrase, '').trim();
      if (next && next !== value) {
        value = next;
        changed = true;
      }
    }
    const words = value.split(' ').filter(Boolean);
    if (words.length <= 1) break;
    const last = words[words.length - 1].toLowerCase();
    const rest = words.slice(0, -1);
    const strip =
      DANGLING_CONNECTORS.has(last) ||
      LEGAL_SUFFIXES.has(last) ||
      (WEAK_SUFFIXES.has(last) && meaningfulWords(rest).length >= 2);
    if (strip && meaningfulWords(rest).length >= 1) {
      value = rest.join(' ').replace(/[-,]+$/, '').trim();
      changed = true;
    }
  }
  return value;
}

function alnum(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Short core name for domain-anchored queries: the shortest word prefix matching the
 * domain label, else the first words. Connector words are skipped while matching the
 * label, so `Bang & Olufsen` / `bang-olufsen.com` resolves to the whole brand instead of
 * the single generic word `Bang`.
 */
export function companyCore(name: string, domain?: string): string {
  const sanitized = sanitizeQueryValue(name);
  const label = domainLabel(domain);
  const words = sanitized.split(' ').filter(Boolean);

  if (words.length === 0) return label;
  if (words.length === 1) return words[0];

  if (label) {
    let acc = '';
    let bestPrefix = -1;
    for (let i = 0; i < words.length; i++) {
      const token = alnum(words[i]);
      if (DANGLING_CONNECTORS.has(words[i].toLowerCase())) continue;
      if (!token) break;
      acc += token;
      if (acc === label) return words.slice(0, i + 1).join(' ');
      if (!label.startsWith(acc)) break;
      bestPrefix = i;
    }
    if (bestPrefix >= 0) {
      const candidate = words.slice(0, bestPrefix + 1);
      if (meaningfulWords(candidate).length >= 2) return candidate.join(' ');
    }
    const first = alnum(words[0]);
    // A one-word prefix only stands in for the whole name when the label adds little.
    if (first.length >= 3 && label.startsWith(first) && label.length - first.length <= 2) return words[0];
  }
  return words.slice(0, 3).join(' ');
}

function domainLabel(domain?: string): string {
  if (!domain) return '';
  let host = domain.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    // keep as-is
  }
  host = host.replace(/^www\./, '');
  const label = host.split('.')[0] ?? '';
  return label.replace(/[^a-z0-9]/g, '');
}

function isPool(value: unknown): value is BrowserPool {
  return Boolean(value) && typeof (value as { acquire?: unknown }).acquire === 'function';
}

function normalizeOptions(opts?: SearchOptions): Required<Pick<SearchOptions, 'gl' | 'hl' | 'num' | 'type'>> & Pick<SearchOptions, 'recency'> {
  const num = opts?.num && opts.num > 0 ? Math.min(Math.floor(opts.num), 100) : DEFAULT_NUM;
  return {
    gl: (opts?.gl || 'us').toLowerCase(),
    hl: (opts?.hl || 'en').toLowerCase(),
    num,
    type: opts?.type === 'news' ? 'news' : 'web',
    recency: opts?.recency,
  };
}

function cacheKey(query: string, opts: ReturnType<typeof normalizeOptions>): string {
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim();
  return JSON.stringify([q, opts.gl, opts.hl, opts.num, opts.type, opts.recency ?? '']);
}

export async function search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
export async function search(query: string, pool: BrowserPool, maxResults?: number): Promise<SearchResult[]>;
export async function search(
  query: string,
  poolOrOpts?: BrowserPool | SearchOptions,
  maxResults?: number
): Promise<SearchResult[]> {
  const opts = isPool(poolOrOpts)
    ? normalizeOptions({ num: maxResults ?? DEFAULT_NUM })
    : normalizeOptions(maxResults !== undefined ? { ...(poolOrOpts as SearchOptions), num: maxResults } : (poolOrOpts as SearchOptions | undefined));

  const trimmed = query.trim();
  if (!trimmed) return [];

  const key = cacheKey(trimmed, opts);
  const hit = cache.get(key);
  if (hit) return hit;

  const serperKey = process.env['SERPER_API_KEY']?.trim();
  if (serperKey) {
    try {
      const results = await serperSearch(trimmed, serperKey, opts);
      console.info(`[search] Serper ${opts.type} returned ${results.length} results for "${trimmed.slice(0, 80)}"`);
      // A transient empty result is not worth an hour of cache: it used to lock a query
      // out of every later cycle in the same process.
      if (results.length > 0) cache.set(key, results);
      return results;
    } catch (err) {
      console.warn('[search] Serper failed:', (err as Error).message, '- falling through');
    }
  } else if (!warnedMissingSerperKey) {
    warnedMissingSerperKey = true;
    console.warn('[search] SERPER_API_KEY not set - using Google News RSS / Bing fallbacks only');
  }

  const results = await fallbackSearch(trimmed, opts);
  if (results.length > 0) cache.set(key, results);
  return results;
}

async function fallbackSearch(query: string, opts: ReturnType<typeof normalizeOptions>): Promise<SearchResult[]> {
  if (opts.type === 'news' || _isNewsQuery(query)) {
    try {
      const results = await _googleNewsRssSearch(query, opts.num, opts.gl, opts.hl);
      if (results.length > 0) {
        console.info(`[search] Google-News-RSS returned ${results.length} results`);
        return results;
      }
      console.warn('[search] Google-News-RSS returned 0 results, falling through');
    } catch (err) {
      console.warn('[search] Google-News-RSS failed:', (err as Error).message, '- falling through');
    }
  }

  try {
    const results = await bingHtmlSearch(query, opts.num, opts.gl, opts.hl);
    if (results.length > 0) {
      console.info(`[search] Bing returned ${results.length} results`);
      return results;
    }
    console.warn('[search] Bing returned 0 results');
  } catch (err) {
    console.warn('[search] Bing failed:', (err as Error).message);
  }

  console.warn('[search] All search backends failed - returning empty results');
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function serperRequestBody(query: string, opts: SearchOptions): Record<string, unknown> {
  const n = normalizeOptions(opts);
  const body: Record<string, unknown> = { q: query, gl: n.gl, hl: n.hl, num: n.num };
  if (n.recency) body['tbs'] = TBS_BY_RECENCY[n.recency];
  return body;
}

async function serperSearch(query: string, apiKey: string, opts: ReturnType<typeof normalizeOptions>): Promise<SearchResult[]> {
  const endpoint = opts.type === 'news' ? 'https://google.serper.dev/news' : 'https://google.serper.dev/search';
  const body = JSON.stringify(serperRequestBody(query, opts));

  for (let attempt = 0; ; attempt++) {
    await serperBucket.take();
    const response = await httpFetch(endpoint, {
      method: 'POST',
      timeoutMs: SERPER_TIMEOUT_MS,
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body,
    });

    if (response.status === 429 && attempt < SERPER_BACKOFF_MS.length) {
      console.warn(`[search] Serper 429, backing off ${SERPER_BACKOFF_MS[attempt]}ms`);
      await sleep(SERPER_BACKOFF_MS[attempt]);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Serper returned HTTP ${response.status}`);
    }
    return parseSerperResponse(response.body, opts.type, opts.num);
  }
}

export function parseSerperResponse(json: string, type: 'web' | 'news', num: number): SearchResult[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Serper returned non-JSON body');
  }
  const items: unknown[] = Array.isArray(type === 'news' ? data?.news : data?.organic)
    ? type === 'news' ? data.news : data.organic
    : [];
  const results: SearchResult[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const url = String(item['link'] ?? '');
    const title = String(item['title'] ?? '');
    if (!url || !title) continue;
    const result: SearchResult = {
      title,
      url,
      snippet: String(item['snippet'] ?? ''),
      position: typeof item['position'] === 'number' ? (item['position'] as number) : results.length + 1,
      source: type === 'news' ? 'serper_news' : 'serper',
    };
    if (item['date']) result.date = String(item['date']);
    results.push(result);
    if (results.length >= num) break;
  }
  return results;
}

function _isNewsQuery(query: string): boolean {
  return /\b(news|funding|launch|launched|partnership|partnered|press|announced|leadership|acquisition|acquired)\b/i.test(query);
}

function _stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, ' ');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', middot: '·', eacute: 'é',
};

/**
 * Pure entity decoder. This used to build a JSDOM PER RSS TAG - about 50 DOM trees for a
 * single Google-News fallback, entirely outside the parse cap.
 */
function _decodeHtml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[String(name).toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function _rssTag(item: string, tag: string): string {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? _stripTags(_decodeHtml(match[1])).replace(/\s+/g, ' ').trim() : '';
}

async function _googleNewsRssSearch(query: string, maxResults: number, gl: string, hl: string): Promise<SearchResult[]> {
  const GL = gl.toUpperCase();
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}-${GL}&gl=${GL}&ceid=${GL}:${hl}`;
  const response = await httpFetch(url, {
    timeoutMs: NEWS_RSS_TIMEOUT_MS,
    headers: { ...DEFAULT_HEADERS, Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Google News RSS returned HTTP ${response.status}`);
  }
  return parseSemaphore.run(async () => parseGoogleNewsRss(response.body, maxResults));
}

export function parseGoogleNewsRss(xml: string, maxResults: number): SearchResult[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  const results: SearchResult[] = [];
  for (const item of items) {
    const title = _rssTag(item, 'title');
    const url = _rssTag(item, 'link');
    const pubDate = _rssTag(item, 'pubDate');
    const source = _rssTag(item, 'source');
    const description = _rssTag(item, 'description');
    if (!title || !url) continue;
    const result: SearchResult = {
      title,
      url,
      snippet: [source ? `Source: ${source}.` : '', description].filter(Boolean).join(' '),
      position: results.length + 1,
      source: 'google_news_rss',
    };
    if (pubDate) result.date = pubDate;
    results.push(result);
    if (results.length >= maxResults) break;
  }
  return results;
}

async function bingHtmlSearch(query: string, maxResults: number, gl: string, hl: string): Promise<SearchResult[]> {
  const proxyUrl = rotatingProxyUrl();
  const count = Math.min(Math.max(maxResults, 1), 10);
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${count}&cc=${gl.toUpperCase()}&setlang=${hl}`;
  const response = await httpFetch(url, {
    timeoutMs: BING_TIMEOUT_MS,
    headers: { ...DEFAULT_HEADERS, 'Cache-Control': 'no-cache' },
    proxyUrl: proxyUrl || undefined,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Bing returned HTTP ${response.status}`);
  }
  // A whole SERP through JSDOM is a real parse: it belongs under the same cap as pages.
  return parseSemaphore.run(async () => parseBingHtml(response.body, maxResults));
}

export function parseBingHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const push = (href: string, title: string, snippet: string) => {
    const url = normalizeResultUrl(href, 'https://www.bing.com');
    if (!url || !title || seen.has(url) || isBingOwnedUrl(url)) return;
    seen.add(url);
    results.push({ title, url, snippet, position: results.length + 1, source: 'bing_proxy' });
  };

  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    for (const block of document.querySelectorAll('li.b_algo, .b_algo')) {
      if (results.length >= maxResults) break;
      const anchor = block.querySelector('h2 a[href], a[href]');
      const href = anchor?.getAttribute('href') || '';
      const title = anchor?.textContent?.replace(/\s+/g, ' ').trim() || '';
      const snippet = block.querySelector('.b_caption p, p')?.textContent?.replace(/\s+/g, ' ').trim() || '';
      push(href, title, snippet);
    }
  } catch {
    // fall back to regex extraction below
  }
  if (results.length > 0) return results;

  const blockPattern = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(html)) !== null && results.length < maxResults) {
    const block = match[1];
    const linkMatch = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(block);
    if (!linkMatch) continue;
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    push(
      linkMatch[1],
      _decodeHtml(_stripTags(linkMatch[2])).trim(),
      snippetMatch ? _decodeHtml(_stripTags(snippetMatch[1])).trim() : ''
    );
  }
  return results;
}

/**
 * Bing wraps most organic results in `https://www.bing.com/ck/a?...&u=a1<base64url>`.
 * Dropping those as "bing-owned" discarded the results Bing actually served, which is
 * why the fallback returned [] and logged "All search backends failed".
 */
export function decodeBingRedirect(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)bing\.com$/i.test(parsed.hostname)) return null;
  if (!/^\/ck\/a/i.test(parsed.pathname)) return null;
  const raw = parsed.searchParams.get('u');
  if (!raw) return null;
  let payload = raw.startsWith('a1') ? raw.slice(2) : raw;
  payload = payload.replace(/-/g, '+').replace(/_/g, '/');
  while (payload.length % 4 !== 0) payload += '=';
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    if (!/^https?:\/\//i.test(decoded)) return null;
    // Round-trip through URL so a mangled payload is rejected rather than passed on.
    return new URL(decoded).toString();
  } catch {
    return null;
  }
}

function normalizeResultUrl(href: string, baseUrl: string): string | null {
  if (!href) return null;
  let absolute: string;
  try {
    absolute = (href.startsWith('http') ? new URL(href) : new URL(href, baseUrl)).toString();
  } catch {
    return null;
  }
  return decodeBingRedirect(absolute) ?? absolute;
}

function isBingOwnedUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'bing.com' || hostname.endsWith('.bing.com');
  } catch {
    return true;
  }
}

/** Test hook: clear the in-process search cache. */
export function _clearSearchCache(): void {
  cache.clear();
}
