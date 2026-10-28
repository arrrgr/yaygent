/**
 * Judge: code-side checks on every extracted candidate. Nothing the model
 * says about itself is trusted; confidence is computed from source tier,
 * quote checks and corroboration (design 2.5).
 */

import { evidenceSearchText, hostOf, type EvidenceItem } from './evidence.js';
import { nameTokens, normalizeName, personNamesMatch } from './names.js';
import type { FieldSpecV2 } from '../templates/v2.js';

export { personNamesMatch } from './names.js';

export interface Candidate {
  field: string;
  value: unknown;
  quote: string;
  source_ref: string;
  model_confidence?: number;
}

export interface PriorCandidate {
  value: unknown;
  host: string;
  /** the entity this value was said about; undefined on flat templates */
  subject?: string;
}

export interface JudgeContext {
  /** the row's own domain (bare host) */
  domain: string;
  /** tokens that identify the company in a snippet (company_core + domain label) */
  companyTokens: string[];
  threshold: number;
  fields: Record<string, FieldSpecV2>;
  /** earlier candidates per field, for cross-cycle corroboration */
  priorCandidates?: Record<string, PriorCandidate[]>;
  /** entity role gate (regex source) - see EntitySpecV2.role_pattern */
  rolePattern?: string;
  /** the entity key field name (e.g. full_name); role gate applies to it */
  entityKey?: string;
  /** when judging a per-entity fan-out: the already-established person's name */
  entityName?: string;
  /**
   * The person this batch of candidates is about (an entity display name).
   * Corroboration must be same-subject: "Co-Founder" said about two different
   * people is not two sources agreeing (review 1.5).
   */
  subjectName?: string;
  /**
   * company name is one short/common token (e.g. "Inevitable"): a LinkedIn
   * snippet alone cannot lock a key field - it needs corroboration from
   * another host.
   */
  ambiguousName?: boolean;
}

export interface Verdict {
  field: string;
  ok: boolean;
  locked: boolean;
  reason?: string;
  value: unknown;
  quote: string;
  source_ref: string;
  source_url: string;
  host: string;
  tier: number;
  conf: number;
  corroborated: boolean;
  verified_by?: 'snippet' | 'profile_cache' | 'jev';
  model_confidence?: number;
}

const PRESS_HOSTS = [
  'crunchbase.com',
  'prnewswire.com',
  'businesswire.com',
  'globenewswire.com',
  'techcrunch.com',
  'forbes.com',
  'bloomberg.com',
  'reuters.com',
  'wsj.com',
  'nytimes.com',
  'wikipedia.org',
  'pitchbook.com',
  'sec.gov',
  'ycombinator.com',
];

// Single-word company names that are plain English words: namesakes are likely.
const COMMON_WORDS = new Set([
  'brain', 'mind', 'cloud', 'data', 'inevitable', 'spark', 'light', 'bridge', 'focus', 'shift', 'trust', 'wave',
  'point', 'scale', 'level', 'prime', 'north', 'south', 'east', 'west', 'core', 'base', 'edge', 'next', 'flow',
  'path', 'drive', 'apex', 'alpha', 'beta', 'omega', 'nova', 'star', 'moon', 'river', 'ocean', 'blue', 'green',
  'red', 'black', 'white', 'gold', 'silver', 'smart', 'simple', 'quick', 'fast', 'one', 'first', 'true', 'real',
  'pure', 'clear', 'open', 'bright', 'digital', 'global', 'united', 'general', 'american', 'national', 'standard',
  'modern', 'future', 'vision', 'insight', 'signal', 'impact', 'motion', 'energy', 'matter', 'logic', 'doers',
  'makers', 'builders', 'labs', 'studio', 'works', 'group', 'systems', 'solutions', 'partners', 'ventures',
  'capital', 'health', 'care', 'home', 'house', 'space', 'time', 'life', 'work', 'play', 'go', 'up', 'on',
  'link', 'connect', 'sync', 'loop', 'circle', 'square', 'arrow', 'rocket', 'summit', 'peak', 'harbor', 'anchor',
  'compass', 'beacon', 'lantern', 'atlas', 'origin', 'element', 'quantum', 'vector', 'matrix', 'nexus', 'vertex',
  'pulse', 'wise', 'able', 'ready', 'bold', 'brave', 'kind', 'good', 'better', 'best', 'super', 'ultra', 'mega',
]);

const ROLE_WORDS = new Set([
  'founder',
  'cofounder',
  'founders',
  'founding',
  'ceo',
  'owner',
  'president',
  'chief',
  'cto',
  'coo',
  'cfo',
  'partner',
]);

const MONTHS = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['may', 'may'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sep', 'sept'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
];

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

export function stripMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]+/g, ' ')
    .replace(/\.{3}|…/g, ' ');
}

export function normalizeText(s: string): string {
  return stripMarkdown(String(s ?? ''))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(s: string): string[] {
  return normalizeText(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Does the needle appear inside the haystack as a CONTIGUOUS run of tokens?
 *
 * This is the gate that makes "the quote must exist in the evidence" mean
 * something. It used to be token-set containment, which let the model splice a
 * name that is nowhere on the page out of tokens that are: value "John Smith"
 * with quote "John Smith, Founder and CEO" locked at confidence 1.0 against a
 * page reading "John Doe, Founder and CEO. Jane Smith, Head of Marketing."
 * (review 1.1). Matching on the token sequence rather than raw text keeps the
 * tolerance for markdown artefacts, punctuation and whitespace that the old
 * check had, while requiring order and adjacency.
 */
export function containsTokenSequence(needle: string[], hay: string[]): boolean {
  if (needle.length === 0) return false;
  if (needle.length > hay.length) return false;
  const first = needle[0]!;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (hay[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** `needle` appears verbatim (after normalisation) inside `hay`. */
export function textContains(hay: string, needle: string): boolean {
  return containsTokenSequence(tokenize(needle), tokenize(hay));
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function normalizeUrlLoose(s: string): string {
  return normalizeText(s).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

/** The `/in/<slug>` part of a LinkedIn profile URL, lowercased, or '' . */
export function linkedinSlug(url: string): string {
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(String(url ?? ''));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]!).toLowerCase().replace(/\/+$/, '');
  } catch {
    return m[1]!.toLowerCase();
  }
}

/** True for linkedin.com itself and its subdomains - never for notlinkedin.com. */
export function isLinkedinHost(host: string): boolean {
  const h = String(host ?? '').toLowerCase();
  return h === 'linkedin.com' || h.endsWith('.linkedin.com');
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function sourceTier(item: EvidenceItem, ownDomain: string): number {
  if (item.kind === 'profile') return 0.95;
  const host = hostOf(item.url);
  if (!host) return 0.6;
  if (ownDomain && (host === ownDomain || host.endsWith(`.${ownDomain}`))) return 1.0;
  if (isLinkedinHost(host) && /linkedin\.com\/in\//i.test(item.url)) return 0.9;
  if (PRESS_HOSTS.some((p) => host === p || host.endsWith(`.${p}`))) return 0.8;
  return 0.6;
}

function dateInQuote(value: string, quote: string): boolean {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(value.trim());
  if (!m) return textContains(quote, value);
  const tokens = new Set(tokenize(quote));
  const year = m[1]!;
  if (!tokens.has(year)) return false;
  if (m[2]) {
    const month = parseInt(m[2], 10);
    const names = MONTHS[month - 1] ?? [];
    const monthOk = names.some((n) => tokens.has(n)) || tokens.has(String(month)) || tokens.has(m[2]);
    if (!monthOk) return false;
  }
  return true;
}

/** Extractive rule: the value appears verbatim inside the quote (URLs also pass on loose substring). */
export function valueInQuote(field: FieldSpecV2, value: unknown, quote: string): boolean {
  const text = valueToText(value);
  if (!text) return false;
  if (field.type === 'date') return dateInQuote(text, quote);
  if (field.type === 'url' || field.type === 'linkedin_person_url') {
    if (normalizeText(quote).replace(/\s+/g, '').includes(normalizeUrlLoose(text).replace(/\s+/g, ''))) return true;
  }
  if (field.type === 'bool') return true;
  return textContains(quote, text);
}

export function quoteInEvidence(quote: string, item: EvidenceItem): boolean {
  if (!quote || tokenize(quote).length === 0) return false;
  return textContains(evidenceSearchText(item), quote);
}

/** Company tokens for the snippet rule: full core, domain label, and long tokens. */
export function companyTokensFor(companyCore: string, domain: string): string[] {
  const out = new Set<string>();
  const core = normalizeText(companyCore);
  if (core) out.add(core);
  const label = domain.replace(/^www\./, '').split('.')[0] ?? '';
  if (label.length >= 3) out.add(label.toLowerCase());
  for (const t of tokenize(companyCore)) if (t.length >= 5) out.add(t);
  return [...out];
}

/**
 * A company name is "ambiguous" when its core is a single token that is short or a
 * plain dictionary-looking word (Inevitable, Brain, Doers): namesakes are likely.
 */
export function isAmbiguousCompanyName(companyCore: string, domain: string): boolean {
  const core = normalizeText(companyCore).trim();
  if (!core) return true;
  const toks = tokenize(core);
  if (toks.length >= 2) return false;
  const tok = toks[0] ?? '';
  const label = domain.replace(/^www\./, '').split('.')[0]?.toLowerCase() ?? '';
  if (COMMON_WORDS.has(tok)) return true;
  // a coined name that is also the domain label (groupraise, unifyr, softily) is distinctive
  if (tok === label && tok.length >= 5) return false;
  return tok.length < 6;
}

export function snippetMentionsCompany(item: EvidenceItem, companyTokens: string[]): boolean {
  const text = normalizeText(`${item.title ?? ''} ${item.text}`);
  const squashed = text.replace(/[^\p{L}\p{N}]+/gu, '');
  const tokens = new Set(tokenize(text));
  return companyTokens.some((ct) => {
    const squashedCt = ct.replace(/[^\p{L}\p{N}]+/gu, '');
    if (!squashedCt) return false;
    if (squashedCt.length >= 5 && squashed.includes(squashedCt)) return true;
    return tokens.has(ct);
  });
}

export function snippetMentionsRole(item: EvidenceItem): boolean {
  const tokens = tokenize(`${item.title ?? ''} ${item.text}`);
  return tokens.some((t) => ROLE_WORDS.has(t));
}

/**
 * Parse a LinkedIn SERP title: "Name - Headline | LinkedIn", "Name - Role - Company | LinkedIn",
 * "Name | LinkedIn". Returns name + headline (everything after the name).
 */
export function parseLinkedinTitle(title: string | undefined): { name: string; headline: string } | null {
  if (!title) return null;
  const cleaned = title.replace(/\s*[|\-\u2013]\s*LinkedIn\s*$/i, '').trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/\s+[-\u2013\u2014]\s+/);
  const name = (parts[0] ?? '').trim();
  const headline = parts.slice(1).join(' - ').trim();
  return { name, headline };
}

/** Role gate: does this text carry an acceptable role for the entity? */
export function roleMatches(text: string | undefined, rolePattern: string | undefined): boolean {
  if (!rolePattern) return true;
  if (!text) return false;
  return new RegExp(rolePattern, 'i').test(text);
}

/**
 * Strict LinkedIn item check: the headline (from the SERP title) must carry the role
 * AND the headline or the first 200 chars of the snippet must mention the company.
 * Prevents "Senior Designer at X ... our founder ..." from passing as a founder of X.
 */
export function linkedinHeadlineVerified(item: EvidenceItem, ctx: JudgeContext): boolean {
  const parsed = parseLinkedinTitle(item.title);
  const headline = parsed?.headline ?? '';
  const lead = (item.text ?? '').slice(0, 200);
  const roleText = headline || lead;
  const roleOk = ctx.rolePattern ? roleMatches(roleText, ctx.rolePattern) : tokenize(roleText).some((t) => ROLE_WORDS.has(t));
  if (!roleOk) return false;
  const probe: EvidenceItem = { ...item, title: headline, text: lead };
  return snippetMentionsCompany(probe, ctx.companyTokens);
}

/**
 * Name-anchored LinkedIn check for a person who is ALREADY established (entity key locked
 * from the company's own site or a founder-headline snippet): the SERP title name must match
 * the entity name, and one more signal must tie the profile to this person - the company
 * anywhere in the item, the role in the headline, or the surname inside the profile slug.
 */
export function linkedinNameAnchored(item: EvidenceItem, ctx: JudgeContext): 'name+company' | 'name+role' | 'name+slug' | null {
  if (!ctx.entityName) return null;
  const parsed = parseLinkedinTitle(item.title);
  if (!parsed || !personNamesMatch(parsed.name, ctx.entityName)) return null;
  if (snippetMentionsCompany(item, ctx.companyTokens)) return 'name+company';
  if (roleMatches(parsed.headline, ctx.rolePattern ?? '\\b(founder|co-?founder|owner|ceo)\\b')) return 'name+role';
  const slug = linkedinSlug(item.url).replace(/[^a-z0-9]+/g, '');
  const toks = nameTokens(ctx.entityName);
  const surname = toks[toks.length - 1] ?? '';
  if (surname.length >= 4 && slug.includes(surname.replace(/[^a-z0-9]+/g, ''))) return 'name+slug';
  return null;
}

/** Is the profile row about the person this call is about? */
function profileIsEntity(item: EvidenceItem, ctx: JudgeContext): boolean {
  if (!ctx.entityName) return true;
  const parsed = parseLinkedinTitle(item.title);
  const name = parsed?.name ?? '';
  if (name && personNamesMatch(name, ctx.entityName)) return true;
  const m = /^Name:\s*(.+)$/im.exec(item.text ?? '');
  return Boolean(m && personNamesMatch(m[1]!.trim(), ctx.entityName));
}

/**
 * Design 2.5 LinkedIn acceptance rule. Returns the verification source or null.
 *
 * `value` is the URL being proposed. It matters: without it the gate only ever
 * looked at the evidence item, so any /in/ URL sitting in a press snippet that
 * also said the company and a role word was "verified" (review 1.3), and a
 * per-entity fan-out could lock a co-founder's profile onto the wrong founder
 * because the headline branch never checked the name (review 1.2).
 */
export function linkedinVerification(
  item: EvidenceItem,
  ctx: JudgeContext,
  value?: string
): 'snippet' | 'profile_cache' | null {
  const wantSlug = value ? linkedinSlug(value) : '';

  if (item.kind === 'profile') {
    if (!item.domain || item.domain !== ctx.domain) return null;
    if (wantSlug && linkedinSlug(item.url) && wantSlug !== linkedinSlug(item.url)) return null;
    if (!profileIsEntity(item, ctx)) return null;
    return 'profile_cache';
  }

  if (/linkedin\.com\/in\//i.test(item.url) && item.title) {
    // the URL must be this item's own profile, not some other /in/ link in its text
    if (wantSlug && wantSlug !== linkedinSlug(item.url)) return null;
    // an entity in scope binds the profile to that person, whichever branch verifies it
    if (ctx.entityName) {
      const parsed = parseLinkedinTitle(item.title);
      if (!parsed || !personNamesMatch(parsed.name, ctx.entityName)) return null;
    }
    if (linkedinHeadlineVerified(item, ctx)) return 'snippet';
    return linkedinNameAnchored(item, ctx) ? 'snippet' : null;
  }

  // A /in/ URL quoted out of a third-party page (crunchbase, a press roundup).
  // Only acceptable when we know whose profile we are looking for AND the slug
  // carries that person's surname; a directory that lists several people used
  // to hand out whichever URL the model picked first.
  if (!ctx.entityName || !wantSlug) return null;
  const toks = nameTokens(ctx.entityName);
  const surname = (toks[toks.length - 1] ?? '').replace(/[^a-z0-9]+/g, '');
  const slug = wantSlug.replace(/[^a-z0-9]+/g, '');
  if (surname.length < 4 || !slug.includes(surname)) return null;
  if (!snippetMentionsCompany(item, ctx.companyTokens)) return null;
  return 'snippet';
}

/** Does this evidence item talk about the subject the candidate is about? */
function mentionsSubject(item: EvidenceItem, ctx: JudgeContext): boolean {
  if (!ctx.subjectName) return true;
  const hay = tokenize(evidenceSearchText(item));
  const toks = nameTokens(ctx.subjectName);
  if (toks.length === 0) return true;
  if (containsTokenSequence(toks, hay)) return true;
  // "Madhura Maskasky" vs "Maskasky, Madhura": first and last token both present
  const set = new Set(hay);
  return toks.length > 1 && set.has(toks[0]!) && set.has(toks[toks.length - 1]!);
}

function isCorroborated(field: FieldSpecV2, value: unknown, source: EvidenceItem, evidence: EvidenceItem[], ctx: JudgeContext): boolean {
  const text = valueToText(value);
  if (!text) return false;
  const sourceHost = hostOf(source.url) || source.kind;
  for (const other of evidence) {
    if (other === source) continue;
    const otherHost = hostOf(other.url) || other.kind;
    if (otherHost === sourceHost) continue;
    if (!mentionsSubject(other, ctx)) continue;
    if (valueInQuote(field, value, evidenceSearchText(other))) return true;
  }
  const norm = normalizeText(text);
  const subject = ctx.subjectName ? normalizeName(ctx.subjectName) : undefined;
  for (const prior of ctx.priorCandidates?.[field.name] ?? []) {
    const priorSubject = prior.subject ? normalizeName(prior.subject) : undefined;
    if (priorSubject !== subject) continue;
    if (prior.host !== sourceHost && normalizeText(valueToText(prior.value)) === norm) return true;
  }
  return false;
}

function reject(cand: Candidate, reason: string, item?: EvidenceItem): Verdict {
  return {
    field: cand.field,
    ok: false,
    locked: false,
    reason,
    value: cand.value,
    quote: cand.quote ?? '',
    source_ref: cand.source_ref ?? '',
    source_url: item?.url ?? '',
    host: item ? hostOf(item.url) : '',
    tier: 0,
    conf: 0,
    corroborated: false,
    model_confidence: cand.model_confidence,
  };
}

export function judgeCandidate(cand: Candidate, evidence: EvidenceItem[], ctx: JudgeContext): Verdict {
  const field = ctx.fields[cand.field];
  if (!field) return reject(cand, 'unknown field');
  if (cand.value === null || cand.value === undefined || valueToText(cand.value).trim() === '') {
    return reject(cand, 'empty value');
  }

  const item = evidence.find((e) => e.ref === cand.source_ref);
  if (!item) return reject(cand, `source_ref ${cand.source_ref || '(none)'} is not an evidence ref`);

  const quote = String(cand.quote ?? '');
  if (!quoteInEvidence(quote, item)) return reject(cand, 'quote not found in evidence', item);

  if (field.kind === 'extractive' && !valueInQuote(field, cand.value, quote)) {
    return reject(cand, 'value not contained in quote', item);
  }

  let verified_by: Verdict['verified_by'];
  if (field.type === 'linkedin_person_url') {
    if (!/linkedin\.com\/in\//i.test(valueToText(cand.value))) return reject(cand, 'not a personal /in/ profile url', item);
    const v = linkedinVerification(item, ctx, valueToText(cand.value));
    if (!v) return reject(cand, 'linkedin url not verified (profile not tied to this person / company + role)', item);
    verified_by = v;
  }

  // Entity role gate on the key field: the person must be shown in the role.
  if (ctx.entityKey && field.name === ctx.entityKey && ctx.rolePattern) {
    const isLinkedin = /linkedin\.com\/in\//i.test(item.url);
    if (isLinkedin) {
      if (!linkedinHeadlineVerified(item, ctx)) {
        return reject(cand, 'role gate: linkedin headline does not show the role at this company', item);
      }
    } else if (!roleMatches(quote, ctx.rolePattern) && !roleMatches(item.title, ctx.rolePattern)) {
      return reject(cand, 'role gate: quote does not carry the entity role', item);
    }
  }

  let tier = sourceTier(item, ctx.domain);
  // Ambiguous company names: a third-party snippet alone cannot lock the key field.
  if (ctx.ambiguousName && ctx.entityKey && field.name === ctx.entityKey && tier < 1 && item.kind !== 'profile') {
    tier = Math.min(tier, 0.65);
  }
  const corroborated = isCorroborated(field, cand.value, item, evidence, ctx);
  const kindFactor = field.kind === 'extractive' ? 1 : 0.9;
  const conf = Math.min(1, tier * kindFactor + (corroborated ? 0.1 : 0));

  return {
    field: cand.field,
    ok: true,
    locked: conf >= ctx.threshold,
    value: cand.value,
    quote,
    source_ref: cand.source_ref,
    source_url: item.url,
    host: hostOf(item.url) || item.kind,
    tier,
    conf: Number(conf.toFixed(4)),
    corroborated,
    verified_by,
    model_confidence: cand.model_confidence,
  };
}

export function judgeAll(cands: Candidate[], evidence: EvidenceItem[], ctx: JudgeContext): Verdict[] {
  return cands.map((c) => judgeCandidate(c, evidence, ctx));
}
