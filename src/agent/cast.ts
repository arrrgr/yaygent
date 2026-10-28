/**
 * Cast: schema types applied in code after the judge (design 2.8).
 * Failed casts become null plus a `cast_failures` entry.
 */

import type { FieldSpecV2 } from '../templates/v2.js';

export interface CastFailure {
  field: string;
  value: unknown;
  reason: string;
}

export interface CastResult {
  ok: boolean;
  value: unknown;
  reason?: string;
}

export interface NumericValue {
  value: number;
  unit?: 'usd' | 'count';
  range?: { min?: number; max?: number };
}

export interface DateValue {
  value: string;
  precision: 'day' | 'month' | 'year';
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const LINKEDIN_PERSON_RE = /^https:\/\/www\.linkedin\.com\/in\/[^/]+$/;

export function normalizeEnumLabel(s: string): string {
  return String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function normalizeLinkedinUrl(raw: string): string | null {
  const s = String(raw).trim();
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  // `endsWith('linkedin.com')` also matches notlinkedin.com / my-linkedin.com, and this
  // function REWRITES whatever it accepts into https://www.linkedin.com/in/<slug> - so a
  // lookalike host became a fabricated real profile URL (review 1.4).
  if (!(host === 'linkedin.com' || host.endsWith('.linkedin.com'))) return null;
  const m = /^\/in\/([^/?#]+)/i.exec(u.pathname);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).replace(/\/+$/, '');
  if (!slug) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

export function normalizeWebUrl(raw: string): string | null {
  const s = String(raw).trim();
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!u.hostname.includes('.')) return null;
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  let out = u.toString();
  if (u.pathname === '/' && !u.search) out = out.replace(/\/$/, '');
  return out;
}

export function parseDate(raw: string): DateValue | null {
  const s = String(raw).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { value: `${m[1]}-${m[2]}-${m[3]}`, precision: 'day' };
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return { value: `${m[1]}-${m[2]}`, precision: 'month' };
  m = /^(\d{4})$/.exec(s);
  if (m) return { value: m[1], precision: 'year' };
  // "March 15, 2026" / "15 March 2026" / "March 2026"
  const lower = s.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  m = /^([a-z]+) (\d{1,2}) (\d{4})$/.exec(lower);
  if (m && MONTH_INDEX[m[1]]) return { value: `${m[3]}-${pad(MONTH_INDEX[m[1]])}-${pad(+m[2])}`, precision: 'day' };
  m = /^(\d{1,2}) ([a-z]+) (\d{4})$/.exec(lower);
  if (m && MONTH_INDEX[m[2]]) return { value: `${m[3]}-${pad(MONTH_INDEX[m[2]])}-${pad(+m[1])}`, precision: 'day' };
  m = /^([a-z]+) (\d{4})$/.exec(lower);
  if (m && MONTH_INDEX[m[1]]) return { value: `${m[2]}-${pad(MONTH_INDEX[m[1]])}`, precision: 'month' };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(lower);
  if (m) return { value: `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`, precision: 'day' };
  m = /\b((?:19|20)\d{2})\b/.exec(lower);
  if (m) return { value: m[1], precision: 'year' };
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

const MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9 };

function parseAmount(s: string): number | null {
  const m = /^\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|mm|b|bn)?\b/i.exec(s.trim());
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const mult = m[2] ? MULTIPLIERS[m[2].toLowerCase()] ?? 1 : 1;
  return base * mult;
}

export function parseNumeric(raw: unknown, unit: 'usd' | 'count'): NumericValue | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw, unit };
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  const range = /^\$?\s*([\d,.]+\s*[kmb]?)\s*(?:-|to|\u2013)\s*\$?\s*([\d,.]+\s*[kmb]?)/i.exec(s);
  if (range) {
    const lo = parseAmount(range[1]);
    const hi = parseAmount(range[2]);
    if (lo === null || hi === null) return null;
    return { value: lo, unit, range: { min: lo, max: hi } };
  }
  const plus = /^\$?\s*([\d,.]+\s*[kmb]?)\s*\+/i.exec(s);
  if (plus) {
    const lo = parseAmount(plus[1]);
    if (lo === null) return null;
    return { value: lo, unit, range: { min: lo } };
  }
  const n = parseAmount(s);
  if (n === null) return null;
  return { value: n, unit };
}

export function castBool(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

export function castValue(field: FieldSpecV2, raw: unknown): CastResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };

  switch (field.type) {
    case 'string':
      return { ok: true, value: String(raw).trim() };
    case 'enum': {
      const want = normalizeEnumLabel(String(raw));
      const hit = (field.enum ?? []).find((e) => normalizeEnumLabel(e) === want);
      return hit !== undefined ? { ok: true, value: hit } : { ok: false, value: null, reason: 'not in enum' };
    }
    case 'bool': {
      const b = castBool(raw);
      return b === null ? { ok: false, value: null, reason: 'not a boolean' } : { ok: true, value: b };
    }
    case 'number': {
      if (!field.numeric) return { ok: true, value: String(raw).trim() };
      const n = parseNumeric(raw, field.numeric.unit);
      return n === null ? { ok: false, value: null, reason: 'not a number' } : { ok: true, value: n };
    }
    case 'url': {
      const u = normalizeWebUrl(String(raw));
      return u === null ? { ok: false, value: null, reason: 'not a url' } : { ok: true, value: u };
    }
    case 'linkedin_person_url': {
      const u = normalizeLinkedinUrl(String(raw));
      if (u === null || !LINKEDIN_PERSON_RE.test(u)) return { ok: false, value: null, reason: 'not a linkedin /in/ url' };
      return { ok: true, value: u };
    }
    case 'date': {
      const d = parseDate(String(raw));
      return d === null ? { ok: false, value: null, reason: 'not a date' } : { ok: true, value: d };
    }
    case 'list<string>': {
      if (Array.isArray(raw)) return { ok: true, value: raw.map((v) => String(v).trim()).filter(Boolean) };
      const parts = String(raw)
        .split(/[;,]/)
        .map((v) => v.trim())
        .filter(Boolean);
      return { ok: true, value: parts };
    }
    default:
      return { ok: false, value: null, reason: `unsupported type ${String(field.type)}` };
  }
}

/** Cast a record of field -> raw value; nulls for missing, failures collected. */
export function castRecord(
  fields: Record<string, FieldSpecV2>,
  values: Record<string, unknown>,
  failures: CastFailure[],
  prefix = ''
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const raw = values[name];
    const res = castValue(spec, raw);
    if (!res.ok) failures.push({ field: `${prefix}${name}`, value: raw, reason: res.reason ?? 'cast failed' });
    out[name] = res.value;
  }
  return out;
}
