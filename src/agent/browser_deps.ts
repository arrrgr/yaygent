/**
 * Single import point for the browser layer (search / fetch / prune).
 * The cycle engine imports only from here so the contract stays in one place.
 */
export { search, sanitizeQueryValue, companyCore } from '../browser/search.js';
export type { SearchResult, SearchOptions } from '../browser/search.js';
export { fetchPage, discoverAndFetch, normalizeUrl } from '../browser/visit.js';
export type { FetchOptions, FetchResult, PageCacheHook, PageCacheEntry } from '../browser/visit.js';
export { pruneForQuestion } from '../browser/prune.js';
