/**
 * Result cache: yaygent.result_cache keyed on template name + template hash +
 * code version + the declared cache_key input values. Complete rows live 30d,
 * incomplete rows 1d. In-process LRU in front; DB optional.
 */

import { createHash } from 'crypto';
import { dbQuery, dbWriteBehind } from './db.js';
import { LRU } from './lru.js';
import type { TemplateV2 } from '../templates/v2.js';

export const RESULT_TTL_COMPLETE_MS = 30 * 24 * 3600 * 1000;
export const RESULT_TTL_INCOMPLETE_MS = 24 * 3600 * 1000;
/**
 * The TTL is bound as SECONDS, not milliseconds. 2_592_000_000 ms does not fit in
 * Postgres int4, so `($2::int * interval '1 millisecond')` raised "out of range for
 * type integer" on every read, dbQuery failed open and the DB half of this cache
 * never returned a single hit (review 2.4).
 */
export const RESULT_TTL_COMPLETE_SECONDS = RESULT_TTL_COMPLETE_MS / 1000;

export interface CachedResult {
  cache_key: string;
  template: string;
  complete: boolean;
  data: unknown;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface ResultCache {
  key(template: TemplateV2, inputs: Record<string, string>, codeVersion: string): string;
  get(key: string): Promise<CachedResult | null>;
  set(entry: Omit<CachedResult, 'created_at'> & { template_hash: string; code_version: string }): void;
}

export function resultCacheKey(template: TemplateV2, inputs: Record<string, string>, codeVersion: string): string {
  const keyInputs: Record<string, string> = {};
  for (const k of template.cache_key) keyInputs[k] = (inputs[k] ?? '').trim().toLowerCase();
  const material = template.name + template.template_hash + codeVersion + JSON.stringify(keyInputs);
  return createHash('sha1').update(material).digest('hex');
}

function ttlFor(complete: boolean): number {
  return complete ? RESULT_TTL_COMPLETE_MS : RESULT_TTL_INCOMPLETE_MS;
}

export const RESULT_CACHE_GET_SQL = `SELECT cache_key, template, complete, data, meta, created_at
           FROM yaygent.result_cache
          WHERE cache_key = $1
            AND created_at > now() - make_interval(secs => $2::int)
          LIMIT 1`;

interface Row {
  cache_key: string;
  template: string;
  complete: boolean;
  data: unknown;
  meta: Record<string, unknown> | null;
  created_at: string | Date;
}

export function createResultCache(opts: { lruSize?: number } = {}): ResultCache {
  const lru = new LRU<CachedResult>(opts.lruSize ?? 1000);

  return {
    key: resultCacheKey,

    async get(key: string): Promise<CachedResult | null> {
      const local = lru.get(key);
      if (local) return local;

      const rows = await dbQuery<Row>(
        RESULT_CACHE_GET_SQL,
        [key, RESULT_TTL_COMPLETE_SECONDS],
        'result_cache.get'
      );
      const row = rows?.[0];
      if (!row) return null;
      const created = new Date(row.created_at).getTime();
      if (!row.complete && Date.now() - created > RESULT_TTL_INCOMPLETE_MS) return null;
      const entry: CachedResult = {
        cache_key: row.cache_key,
        template: row.template,
        complete: row.complete,
        data: row.data,
        meta: row.meta ?? {},
        created_at: new Date(row.created_at).toISOString(),
      };
      lru.set(key, entry, Math.max(0, ttlFor(row.complete) - (Date.now() - created)));
      return entry;
    },

    set(entry): void {
      const created_at = new Date().toISOString();
      lru.set(entry.cache_key, { ...entry, created_at }, ttlFor(entry.complete));
      dbWriteBehind(
        `INSERT INTO yaygent.result_cache (cache_key, template, template_hash, code_version, complete, data, meta, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now())
         ON CONFLICT (cache_key) DO UPDATE
           SET template = EXCLUDED.template, template_hash = EXCLUDED.template_hash,
               code_version = EXCLUDED.code_version, complete = EXCLUDED.complete,
               data = EXCLUDED.data, meta = EXCLUDED.meta, created_at = now()`,
        [
          entry.cache_key,
          entry.template,
          entry.template_hash,
          entry.code_version,
          entry.complete,
          JSON.stringify(entry.data),
          JSON.stringify(entry.meta),
        ],
        'result_cache.set'
      );
    },
  };
}
