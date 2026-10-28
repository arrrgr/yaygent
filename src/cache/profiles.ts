/**
 * Evidence tier 0: read-only lookup in public.linkedin_profiles (the shared
 * Apify cache) by current_company_domain, and by company slug when a
 * company_linkedin_url is given. Never scrapes.
 */

import { dbQuery } from './db.js';
import type { EvidenceItem } from '../agent/evidence.js';

export const PROFILE_LIMIT = 10;

interface ProfileRow {
  linkedin_url: string;
  full_name: string | null;
  headline: string | null;
  current_title: string | null;
  current_company: string | null;
  current_company_domain: string | null;
  location: string | null;
  experience: unknown;
  education: unknown;
}

/** `%` and `_` inside a slug are ILIKE wildcards; escape them (review 3.8). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function companySlug(companyLinkedinUrl: string | undefined): string | null {
  if (!companyLinkedinUrl) return null;
  const m = /linkedin\.com\/company\/([^/?#]+)/i.exec(companyLinkedinUrl);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function summarizeList(raw: unknown, pick: (r: Record<string, unknown>) => string, max = 6): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .slice(0, max)
    .map((r) => (r && typeof r === 'object' ? pick(r as Record<string, unknown>) : ''))
    .filter(Boolean)
    .join('; ');
}

export function summarizeExperience(raw: unknown): string {
  return summarizeList(raw, (r) => {
    const title = str(r['title'] ?? r['position'] ?? r['role']);
    const company = str(r['companyName'] ?? r['company'] ?? r['company_name']);
    const start = str(r['startDate'] ?? r['start'] ?? r['start_date'] ?? r['duration']);
    const loc = str(r['location']);
    return [title, company ? `at ${company}` : '', start ? `(${start})` : '', loc ? `- ${loc}` : ''].filter(Boolean).join(' ');
  });
}

export function summarizeEducation(raw: unknown): string {
  return summarizeList(raw, (r) => {
    const school = str(r['schoolName'] ?? r['school'] ?? r['institution']);
    const degree = str(r['degree'] ?? r['degreeName'] ?? r['fieldOfStudy']);
    const years = str(r['years'] ?? r['startDate'] ?? r['start'] ?? r['period']);
    return [school, degree ? `- ${degree}` : '', years ? `(${years})` : ''].filter(Boolean).join(' ');
  });
}

export function profileToEvidence(row: ProfileRow, ref: string, matchedDomain: string): EvidenceItem {
  const lines = [
    `Name: ${str(row.full_name)}`,
    `Title: ${str(row.current_title)}`,
    `Company: ${str(row.current_company)}${row.current_company_domain ? ` (${row.current_company_domain})` : ''}`,
    `Headline: ${str(row.headline)}`,
    `Location: ${str(row.location)}`,
    `LinkedIn: ${row.linkedin_url}`,
    `Education: ${summarizeEducation(row.education)}`,
    `Experience: ${summarizeExperience(row.experience)}`,
  ];
  return {
    ref,
    kind: 'profile',
    url: row.linkedin_url,
    title: `${str(row.full_name)} - ${str(row.current_title)} - ${str(row.current_company)} | LinkedIn`,
    text: lines.join('\n'),
    domain: matchedDomain,
  };
}

export type ProfileLookup = (domain: string, companyLinkedinUrl?: string) => Promise<EvidenceItem[]>;

export interface ScrapeOptions {
  /** wall time left for the whole scrape; checked between URLs */
  budgetMs?: number;
}

/** Scrape (cache first, Apify on a miss) a handful of /in/ URLs and return them as evidence. */
export type ProfileScraper = (
  urls: string[],
  domain: string,
  companyTokens: string[],
  opts?: ScrapeOptions
) => Promise<EvidenceItem[]>;

const APIFY_ACTOR = 'apimaestro~linkedin-profile-detail';

/** Strip anything that looks like a token or a password out of a string before logging it. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(token=)[^&\s'"]+/gi, '$1<redacted>')
    .replace(/(apify_[A-Za-z0-9]+)/g, '<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>')
    .replace(/(:\/\/[^:@\s]+:)[^@\s]+@/g, '$1<redacted>@');
}
const APIFY_TIMEOUT_MS = 90_000;
const CACHE_MAX_AGE_DAYS = 30;

export function normalizeLinkedinUrl(url: string): string | null {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1])}` : null;
}

function words(v: string): string[] {
  return v
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whole-token company match. The old rule was bidirectional substring on
 * squashed tokens with a 4-char floor, so "rust" matched "trustlayer" and
 * "core" matched "coreweave" - and the result is written into
 * `public.linkedin_profiles.current_company_domain`, the column every client
 * schema joins on (review 1.9).
 */
export function companyNameMatches(name: string, companyTokens: string[]): boolean {
  const nameWords = words(name);
  if (nameWords.length === 0) return false;
  const squashedName = nameWords.join('');
  const nameSet = new Set(nameWords);
  return companyTokens.some((ct) => {
    const ctWords = words(ct);
    if (ctWords.length === 0) return false;
    if (ctWords.join('').length < 4) return false;
    if (ctWords.join('') === squashedName) return true;
    return ctWords.every((w) => nameSet.has(w));
  });
}

function isCurrentExperience(e: Record<string, unknown>): boolean {
  if (e['is_current'] === true) return true;
  const end = str(e['end_date'] ?? e['endDate'] ?? e['ends_at'] ?? e['duration']);
  return /present|current/i.test(end);
}

/**
 * Does a CURRENT experience entry (or the headline, which is current by nature)
 * tie this profile to the company? A past employer no longer counts - someone
 * who left five years ago was being relabelled as current.
 */
export function profileMatchesCompany(raw: Record<string, unknown>, companyTokens: string[]): boolean {
  if (companyTokens.length === 0) return false;
  const exp = Array.isArray(raw['experience']) ? (raw['experience'] as Array<Record<string, unknown>>) : [];
  const basic = (raw['basic_info'] as Record<string, unknown> | undefined) ?? {};
  const current = exp.filter(isCurrentExperience).map((e) => str(e['company'] ?? e['companyName']));
  const headline = str(basic['headline']);
  return [...current, headline].filter(Boolean).some((t) => companyNameMatches(t, companyTokens));
}

/** Bare registrable-ish host of a website value: "http://www.Foo.com/x" -> "foo.com". */
export function siteDomain(url: string): string {
  return String(url ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#:]/)[0] ?? '';
}

export function sameSite(website: string, bare: string): boolean {
  const w = siteDomain(website);
  if (!w || !bare) return false;
  return w === bare || w.endsWith(`.${bare}`) || bare.endsWith(`.${w}`);
}

const COMPANY_ACTOR = 'apimaestro~linkedin-company-detail';
/** company LinkedIn url -> website ('' = page has none, null = could not read it) */
const employerSites = new Map<string, Promise<string | null>>();

async function scrapeEmployerWebsite(companyUrl: string, token: string): Promise<string | null> {
  const cached = await dbQuery<{ website: string | null }>(
    `SELECT website FROM yaygent.linkedin_companies WHERE company_url = $1 AND scraped_at > now() - ($2 || ' days')::interval LIMIT 1`,
    [companyUrl, String(CACHE_MAX_AGE_DAYS)],
    'companies.by_url'
  );
  if (cached?.[0]) return cached[0].website ?? '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/${COMPANY_ACTOR}/run-sync-get-dataset-items?timeout=80`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ identifier: [companyUrl] }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const items = (await res.json()) as unknown;
    const first = (Array.isArray(items) ? items[0] : null) as Record<string, unknown> | null;
    const basic = (first?.['basic_info'] as Record<string, unknown> | undefined) ?? undefined;
    if (!basic?.['name']) return null;
    const website = str(basic['website']);
    void dbQuery(
      `INSERT INTO yaygent.linkedin_companies (company_url, company_id, name, website, website_domain, raw, scraped_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (company_url) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website,
         website_domain = EXCLUDED.website_domain, raw = EXCLUDED.raw, scraped_at = now()`,
      [companyUrl, str(first?.['company_urn']) || null, str(basic['name']), website || null, siteDomain(website) || null, JSON.stringify(first)],
      'companies.upsert'
    ).catch(() => undefined);
    return website;
  } catch (err) {
    console.warn(`[profiles] company page failed for ${companyUrl}: ${redactSecrets((err as Error).message)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function employerWebsite(companyUrl: string): Promise<string | null> {
  const token = process.env['APIFY_API_TOKEN'];
  if (!token || !/linkedin\.com\/company\//i.test(companyUrl)) return Promise.resolve(null);
  const key = companyUrl.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  let p = employerSites.get(key);
  if (!p) {
    p = scrapeEmployerWebsite(key, token);
    employerSites.set(key, p);
  }
  return p;
}

/** "fieldguide.io" vs "fieldguide.com": same brand label, different TLD. */
export function sameLabel(website: string, bare: string): boolean {
  const a = siteDomain(website).split('.')[0] ?? '';
  const b = bare.split('.')[0] ?? '';
  return a.length >= 4 && a === b;
}

export interface EmployerMatch {
  /** the experience entry that ties the profile to this company; -1 = headline only */
  index: number;
  current: boolean;
}

/**
 * Which job ties this profile to the company? Current jobs first, then past ones (a founder who
 * left is still a founder; the evidence says "former" so nobody mistakes it for a current role).
 * A job counts when its employer page lists OUR website (whatever the name), or when the name
 * matches and the employer page does not list a clearly different site (research-ops-kit's
 * namesake check; same label on another TLD is not "different", an unreadable page fails open).
 */
export async function employerMatch(raw: Record<string, unknown>, companyTokens: string[], bare: string): Promise<EmployerMatch | null> {
  const exp = Array.isArray(raw['experience']) ? (raw['experience'] as Array<Record<string, unknown>>) : [];
  const order = exp.map((e, i) => ({ e, i, cur: isCurrentExperience(e) })).sort((a, b) => Number(b.cur) - Number(a.cur));
  let contradicted = false;
  for (const { e, i, cur } of order) {
    const url = str(e['company_linkedin_url'] ?? e['companyUrl']);
    const named = companyNameMatches(str(e['company'] ?? e['companyName']), companyTokens);
    // a past job is only worth a company-page read when its name already matches
    if (!named && !(cur && url)) continue;
    const site = url ? await employerWebsite(url) : null;
    if (site && sameSite(site, bare)) return { index: i, current: cur };
    if (named && (!site || sameLabel(site, bare))) return { index: i, current: cur };
    if (named) contradicted = true;
  }
  // "Co-founder & CEO at Fabric" in the headline must not rescue a profile whose Fabric job
  // links to a different company's website
  if (contradicted) return null;
  return profileMatchesCompany(raw, companyTokens) ? { index: -1, current: true } : null;
}

/** Kept for callers that only need yes/no: a CURRENT tie to the company. */
export async function employerMatches(raw: Record<string, unknown>, companyTokens: string[], bare: string): Promise<boolean> {
  const m = await employerMatch(raw, companyTokens, bare);
  return Boolean(m?.current);
}

/** The profile as evidence, framed on the job that ties it to this company. */
function evidenceRow(row: ProfileRow, raw: Record<string, unknown>, m: EmployerMatch | null): ProfileRow {
  if (!m || m.index < 0) return row;
  const exp = Array.isArray(raw['experience']) ? (raw['experience'] as Array<Record<string, unknown>>) : [];
  const e = exp[m.index];
  if (!e) return row;
  const title = str(e['title']);
  return { ...row, current_title: m.current ? title : `${title} (former)`, current_company: str(e['company']) || row.current_company };
}

function apifyRowToProfileRow(url: string, raw: Record<string, unknown>, matchedDomain: string | null): ProfileRow {
  const basic = (raw['basic_info'] as Record<string, unknown> | undefined) ?? {};
  const exp = Array.isArray(raw['experience']) ? (raw['experience'] as Array<Record<string, unknown>>) : [];
  const current = exp.find((e) => e['is_current'] === true) ?? exp[0];
  return {
    linkedin_url: url,
    full_name: str(basic['fullname']) || null,
    headline: str(basic['headline']) || null,
    current_title: current ? str(current['title']) || null : null,
    current_company: current ? str(current['company']) || null : null,
    current_company_domain: matchedDomain,
    location: str(basic['location']) || null,
    experience: exp,
    education: raw['education'] ?? [],
  };
}

async function apifyScrape(slug: string, token: string, timeoutMs = APIFY_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    // Token goes in a header, never the URL: node-fetch error messages embed the request URL,
    // so a token in the query string leaks into the logs on any network failure.
    const res = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?timeout=80`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ username: slug }),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      console.warn(`[profiles] apify ${res.status} for ${slug}`);
      return null;
    }
    const items = (await res.json()) as unknown;
    const first = Array.isArray(items) ? items[0] : null;
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
  } catch (err) {
    console.warn(`[profiles] apify failed for ${slug}: ${redactSecrets((err as Error).message)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function cacheProfile(row: ProfileRow, raw: Record<string, unknown>): Promise<void> {
  const basic = (raw['basic_info'] as Record<string, unknown> | undefined) ?? {};
  await dbQuery(
    `INSERT INTO public.linkedin_profiles
       (linkedin_url, slug, full_name, first_name, last_name, headline, location, summary, current_title,
        current_company, current_company_domain, experience, education, connections, followers, raw, scraped_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),now())
     ON CONFLICT (linkedin_url) DO UPDATE SET
       full_name = EXCLUDED.full_name, headline = EXCLUDED.headline, current_title = EXCLUDED.current_title,
       current_company = EXCLUDED.current_company,
       -- EXISTING WINS. This column is shared with every client schema and is
       -- documented as the join key; our value is a guess from a token match, so
       -- it may only ever FILL the column, never overwrite it (review 1.9).
       current_company_domain = COALESCE(public.linkedin_profiles.current_company_domain, EXCLUDED.current_company_domain),
       experience = EXCLUDED.experience, education = EXCLUDED.education, raw = EXCLUDED.raw,
       scraped_at = now(), updated_at = now()`,
    [
      row.linkedin_url,
      row.linkedin_url.split('/in/')[1] ?? null,
      row.full_name,
      str(basic['first_name']) || null,
      str(basic['last_name']) || null,
      row.headline,
      row.location,
      (str(basic['about']) || null)?.slice(0, 4000) ?? null,
      row.current_title,
      row.current_company,
      row.current_company_domain,
      JSON.stringify(row.experience ?? []),
      JSON.stringify(row.education ?? []),
      Number.isFinite(Number(basic['connection_count'])) ? Number(basic['connection_count']) : null,
      Number.isFinite(Number(basic['follower_count'])) ? Number(basic['follower_count']) : null,
      JSON.stringify(raw),
    ],
    'profiles.upsert'
  );
}

export const scrapeProfiles: ProfileScraper = async (urls, domain, companyTokens, opts = {}) => {
  const token = process.env['APIFY_API_TOKEN'];
  const bare = domain.replace(/^www\./i, '').toLowerCase();
  const out: EvidenceItem[] = [];
  const seen = new Set<string>();
  // Two sequential 90s Apify timeouts used to blow straight through the route
  // timeout and throw the whole row away (review 2.8).
  const deadline = opts.budgetMs !== undefined ? Date.now() + opts.budgetMs : undefined;
  for (const rawUrl of urls) {
    const url = normalizeLinkedinUrl(rawUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const remaining = deadline === undefined ? APIFY_TIMEOUT_MS : deadline - Date.now();
    if (remaining <= 1000) {
      console.warn('[profiles] wall budget spent; stopping profile_scrape');
      break;
    }

    const cached = await dbQuery<ProfileRow & { raw: unknown; scraped_at: string }>(
      `SELECT linkedin_url, full_name, headline, current_title, current_company, current_company_domain,
              location, experience, education, raw, scraped_at
         FROM public.linkedin_profiles
        WHERE linkedin_url = $1 AND scraped_at > now() - ($2 || ' days')::interval
        LIMIT 1`,
      [url, String(CACHE_MAX_AGE_DAYS)],
      'profiles.by_url'
    );
    const hit = cached?.[0];
    if (hit) {
      const raw = (hit.raw && typeof hit.raw === 'object' ? hit.raw : {}) as Record<string, unknown>;
      const m = Object.keys(raw).length > 0 ? await employerMatch(raw, companyTokens, bare) : hit.current_company_domain === bare ? { index: -1, current: true } : null;
      const matched = Boolean(m);
      out.push(profileToEvidence(evidenceRow(hit, raw, m), `[${out.length + 1}]`, matched ? bare : ''));
      console.info(`[profiles] cache hit ${url} matched=${matched}`);
      continue;
    }
    if (!token) {
      console.warn('[profiles] APIFY_API_TOKEN not set; profile_scrape skipped');
      break;
    }
    const slug = url.split('/in/')[1] ?? '';
    const raw = await apifyScrape(slug, token, Math.min(APIFY_TIMEOUT_MS, remaining));
    if (!raw) continue;
    const m = await employerMatch(raw, companyTokens, bare);
    const matched = Boolean(m);
    // the shared column is stamped only for a CURRENT tie (review 1.9); a past founder is evidence, not a join key
    const row = apifyRowToProfileRow(url, raw, m?.current ? bare : null);
    void cacheProfile(row, raw).catch((err: unknown) => console.warn(`[profiles] cache write failed: ${(err as Error).message}`));
    out.push(profileToEvidence(evidenceRow(row, raw, m), `[${out.length + 1}]`, matched ? bare : ''));
    console.info(`[profiles] apify scraped ${url} matched=${matched}`);
  }
  return out;
};

export const lookupProfiles: ProfileLookup = async (domain, companyLinkedinUrl) => {
  const bare = domain.replace(/^www\./i, '').toLowerCase();
  if (!bare) return [];

  const seen = new Set<string>();
  /** `matched` says whether this row is known to belong to THIS company. */
  const rows: Array<{ row: ProfileRow; matched: boolean }> = [];

  const byDomain = await dbQuery<ProfileRow>(
    `SELECT linkedin_url, full_name, headline, current_title, current_company, current_company_domain,
            location, experience, education
       FROM public.linkedin_profiles
      WHERE current_company_domain = $1
      LIMIT $2`,
    [bare, PROFILE_LIMIT],
    'profiles.by_domain'
  );
  for (const r of byDomain ?? []) {
    if (!seen.has(r.linkedin_url)) {
      seen.add(r.linkedin_url);
      rows.push({ row: r, matched: true });
    }
  }

  const slug = companySlug(companyLinkedinUrl);
  if (slug && rows.length < PROFILE_LIMIT) {
    const bySlug = await dbQuery<ProfileRow>(
      `SELECT linkedin_url, full_name, headline, current_title, current_company, current_company_domain,
              location, experience, education
         FROM public.linkedin_profiles
        WHERE raw::text ILIKE $1
        LIMIT $2`,
      [`%linkedin.com/company/${escapeLike(slug)}%`, PROFILE_LIMIT],
      'profiles.by_slug'
    );
    for (const r of bySlug ?? []) {
      if (!seen.has(r.linkedin_url)) {
        seen.add(r.linkedin_url);
        // This query matches the slug ANYWHERE in the Apify payload - an old job,
        // a "people also viewed" blob. Stamping it as this company's domain made
        // `judge.linkedinVerification` treat a former employee as a verified
        // current founder at tier 0.95 (review 1.8). Only the row whose own
        // current_company_domain already says so is stamped.
        rows.push({ row: r, matched: r.current_company_domain === bare });
      }
    }
  }

  return rows
    .slice(0, PROFILE_LIMIT)
    .map(({ row, matched }, i) => profileToEvidence(row, `[${i + 1}]`, matched ? bare : ''));
};
