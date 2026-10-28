/**
 * Optional Postgres access (Supabase via the Supavisor session pooler).
 * No YAYGENT_DATABASE_URL = no pool; every call fails open and logs.
 */

import pg from 'pg';

export const DB_TIMEOUT_MS = 3000;

let pool: pg.Pool | null | undefined;
let configuredUrl: string | undefined;

/** Remove the sslmode parameter so an explicit `ssl` option is the only source of truth. */
export function stripSslMode(databaseUrl: string): string {
  return databaseUrl.replace(/([?&])sslmode=[^&]*&?/i, (_m, sep: string) => (sep === '?' ? '?' : '&'))
    .replace(/[?&]$/, '');
}

/** `sslmode=require` means encrypt-without-verify; `verify-full` keeps verification on. */
export function sslOptionFor(databaseUrl: string): { rejectUnauthorized: boolean } | undefined {
  const mode = /[?&]sslmode=([^&]+)/.exec(databaseUrl)?.[1]?.toLowerCase();
  if (!mode || mode === 'disable') return undefined;
  if (mode === 'verify-full' || mode === 'verify-ca') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

export function configureDb(databaseUrl: string | undefined): void {
  if (databaseUrl === configuredUrl && pool !== undefined) return;
  if (pool) {
    void pool.end().catch(() => undefined);
  }
  configuredUrl = databaseUrl;
  pool = databaseUrl
    ? new pg.Pool({
        // sslmode is stripped from the URL: node-postgres lets the parsed connection string
        // override an explicit `ssl` option, and it maps `sslmode=require` to FULL chain
        // verification. Supabase's Supavisor pooler presents a self-signed chain, so every
        // query failed open and the whole cache + profile layer was silently dead.
        connectionString: stripSslMode(databaseUrl),
        ssl: sslOptionFor(databaseUrl),
        max: 5,
        connectionTimeoutMillis: DB_TIMEOUT_MS,
        idleTimeoutMillis: 30_000,
        statement_timeout: DB_TIMEOUT_MS,
      })
    : null;
  if (pool) pool.on('error', (err) => console.warn('[db] pool error:', err.message));
}

export function dbEnabled(): boolean {
  if (pool === undefined) configureDb(process.env['YAYGENT_DATABASE_URL'] || undefined);
  return Boolean(pool);
}

/**
 * Run a query with a hard timeout. Returns null on any failure (fail open).
 */
export async function dbQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  label = 'query'
): Promise<T[] | null> {
  if (!dbEnabled() || !pool) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DB_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([pool.query<T>(sql, params), timeout]);
    if (result === null) {
      console.warn(`[db] ${label} timed out after ${DB_TIMEOUT_MS}ms`);
      return null;
    }
    return result.rows;
  } catch (err) {
    console.warn(`[db] ${label} failed:`, (err as Error).message);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Write-behind: fire and forget, never awaited by the request path. */
export function dbWriteBehind(sql: string, params: unknown[], label = 'write'): void {
  void dbQuery(sql, params, label);
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end().catch(() => undefined);
  pool = undefined;
  configuredUrl = undefined;
}
