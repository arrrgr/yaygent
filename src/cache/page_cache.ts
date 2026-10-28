/**
 * Page cache: PageCacheHook over yaygent.page_cache (TTL 7d) with an
 * in-process LRU (2000 entries) in front. Challenge pages, 4xx/5xx and thin
 * bodies are never stored (the fetch layer decides; we also guard here).
 */

import { dbQuery, dbWriteBehind } from './db.js';
import { LRU } from './lru.js';
import type { PageCacheEntry, PageCacheHook } from '../agent/browser_deps.js';

export const PAGE_TTL_MS = 7 * 24 * 3600 * 1000;
export const PAGE_MIN_BODY_CHARS = 500;

interface Row {
  url_norm: string;
  url_final: string;
  status: number;
  tier: string;
  bytes: number;
  markdown: string;
  fetched_at: string | Date;
}

export function storablePage(entry: PageCacheEntry): boolean {
  if (entry.status < 200 || entry.status >= 400) return false;
  if (!entry.markdown || entry.markdown.length < PAGE_MIN_BODY_CHARS) return false;
  return true;
}

export function createPageCache(opts: { lruSize?: number } = {}): PageCacheHook & { hits: () => number } {
  const lru = new LRU<PageCacheEntry>(opts.lruSize ?? 2000);
  let hits = 0;

  return {
    hits: () => hits,

    async get(urlNorm: string): Promise<PageCacheEntry | null> {
      const local = lru.get(urlNorm);
      if (local) {
        hits++;
        return local;
      }
      const rows = await dbQuery<Row>(
        `SELECT url_norm, url_final, status, tier, bytes, markdown, fetched_at
           FROM yaygent.page_cache
          WHERE url_norm = $1
            AND fetched_at > now() - interval '7 days'
          LIMIT 1`,
        [urlNorm],
        'page_cache.get'
      );
      const row = rows?.[0];
      if (!row) return null;
      const entry: PageCacheEntry = {
        url_norm: row.url_norm,
        url_final: row.url_final,
        status: row.status,
        tier: row.tier,
        bytes: row.bytes,
        markdown: row.markdown,
        fetched_at: new Date(row.fetched_at).toISOString(),
      };
      const age = Date.now() - new Date(row.fetched_at).getTime();
      lru.set(urlNorm, entry, Math.max(0, PAGE_TTL_MS - age));
      hits++;
      return entry;
    },

    set(entry: PageCacheEntry): void {
      if (!storablePage(entry)) return;
      lru.set(entry.url_norm, entry, PAGE_TTL_MS);
      dbWriteBehind(
        `INSERT INTO yaygent.page_cache (url_norm, fetched_at, status, tier, bytes, url_final, markdown)
         VALUES ($1, now(), $2, $3, $4, $5, $6)
         ON CONFLICT (url_norm) DO UPDATE
           SET fetched_at = now(), status = EXCLUDED.status, tier = EXCLUDED.tier,
               bytes = EXCLUDED.bytes, url_final = EXCLUDED.url_final, markdown = EXCLUDED.markdown`,
        [entry.url_norm, entry.status, entry.tier, entry.bytes, entry.url_final, entry.markdown],
        'page_cache.set'
      );
    },
  };
}
