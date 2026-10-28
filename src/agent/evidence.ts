/**
 * Evidence items are what the extractor sees and what the judge checks
 * against. `ref` is the only thing the model may cite.
 */

import type { SearchResult } from './browser_deps.js';

export type EvidenceKind = 'search' | 'page' | 'profile';

export interface EvidenceItem {
  ref: string;
  kind: EvidenceKind;
  url: string;
  title?: string;
  date?: string;
  text: string;
  /** profile items: the company domain the profile was matched on */
  domain?: string;
}

export const PAGE_EVIDENCE_MAX_CHARS = 4000;

export function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Serper dates arrive as "3 days ago", "Mar 3, 2026" or ISO. Resolve to
 * YYYY-MM-DD in code so the model never decides what is recent.
 */
export function resolveDate(raw: string | undefined, now: Date = new Date()): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const rel = /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i.exec(s);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const d = new Date(now.getTime());
    if (unit === 'second' || unit === 'minute' || unit === 'hour') return d.toISOString().slice(0, 10);
    if (unit === 'day') d.setUTCDate(d.getUTCDate() - n);
    if (unit === 'week') d.setUTCDate(d.getUTCDate() - 7 * n);
    if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - n);
    if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() - n);
    return d.toISOString().slice(0, 10);
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return s;
}

export function searchEvidence(results: SearchResult[], now: Date = new Date()): EvidenceItem[] {
  return results.map((r, i) => ({
    ref: `[${i + 1}]`,
    kind: 'search',
    url: r.url,
    title: r.title,
    date: resolveDate(r.date, now),
    text: r.snippet,
  }));
}

export function pageEvidence(url: string, markdown: string, title?: string): EvidenceItem[] {
  const text = markdown.length > PAGE_EVIDENCE_MAX_CHARS ? markdown.slice(0, PAGE_EVIDENCE_MAX_CHARS) : markdown;
  return [{ ref: '[1]', kind: 'page', url, title, text }];
}

/** Everything the judge may match a quote against for one item. */
export function evidenceSearchText(item: EvidenceItem): string {
  return [item.title ?? '', item.url, item.date ? `date: ${item.date}` : '', item.text].join(' | ');
}

export function formatEvidence(items: EvidenceItem[]): string {
  return items
    .map((it) => {
      const head = [it.ref, `(${it.kind})`, it.title ? it.title : '', it.url, it.date ? `date: ${it.date}` : '']
        .filter(Boolean)
        .join(' | ');
      return `${head}\n${it.text}`;
    })
    .join('\n\n');
}
