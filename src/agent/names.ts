/**
 * The one person-name normaliser for the whole engine.
 *
 * entities.ts (entity merge / display) and judge.ts (LinkedIn name anchoring)
 * used to carry two different normalisers. When a display name picked up a
 * title suffix ("Patrick Collison (CEO)") the judge's normaliser kept the
 * suffix, `personNamesMatch` failed and the name-anchored LinkedIn path turned
 * itself off for exactly the founders whose evidence names them with a role
 * attached (review 1.10). Everything now goes through this file.
 */

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'madam', 'mx']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'mba', 'md', 'cpa', 'esq', 'dds', 'pe']);

function letters(token: string): string {
  return token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** lowercase, NFKC, strip honorifics/suffixes/parentheticals/trailing clauses/punctuation. */
export function normalizeName(name: string): string {
  const cleaned = String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[,;|/\\]+.*$/, ' ')
    .replace(/[^\p{L}\p{N}\s.'-]+/gu, ' ')
    .replace(/[.'-]+/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !HONORIFICS.has(t))
    .filter((t) => !SUFFIXES.has(t))
    .join(' ');
}

/** Normalised name tokens; single-letter initials are kept ("rameez r"). */
export function nameTokens(name: string): string[] {
  return normalizeName(name).split(' ').filter(Boolean);
}

/**
 * The name with its original casing but without the things that are not part
 * of a name: parentheticals, a trailing ", Co-Founder" clause, a " - Founder"
 * clause, honorifics and suffixes. The display form must survive
 * `personNamesMatch` against the same person named plainly.
 */
export function cleanDisplayName(raw: string): string {
  const original = String(raw ?? '').trim();
  const stripped = original
    .normalize('NFKC')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[,;|/\\]+.*$/, ' ')
    .replace(/\s+[-\u2013\u2014]\s+.*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = stripped.split(' ').filter(Boolean);
  while (parts.length > 1 && HONORIFICS.has(letters(parts[0]!))) parts.shift();
  while (parts.length > 1 && SUFFIXES.has(letters(parts[parts.length - 1]!))) parts.pop();
  return parts.join(' ') || original;
}

function tokenPairMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

/**
 * Entity merge rule: "p collison" ~ "patrick collison", "rameez r" ~ "rameez
 * remsudeen". First and last tokens must match exactly or by initial, and at
 * least one aligned pair must be a full token; single-token names match only
 * when identical.
 */
export function namesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta.join(' ') === tb.join(' ')) return true;
  if (ta.length === 1 || tb.length === 1) return false;
  const first: [string, string] = [ta[0]!, tb[0]!];
  const last: [string, string] = [ta[ta.length - 1]!, tb[tb.length - 1]!];
  if (!tokenPairMatches(...first) || !tokenPairMatches(...last)) return false;
  const exactFull = (pair: [string, string]) => pair[0] === pair[1] && pair[0].length > 1;
  return exactFull(first) || exactFull(last);
}

/** Loose person match for verification: same first token (or initial) and same last token (or initial). */
export function personNamesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  return tokenPairMatches(ta[0]!, tb[0]!) && tokenPairMatches(ta[ta.length - 1]!, tb[tb.length - 1]!);
}

/** Prefer the fuller name as the display form ("Patrick Collison" over "P. Collison"). */
export function betterDisplay(current: string, incoming: string): string {
  const cleanCurrent = cleanDisplayName(current);
  const cleanIncoming = cleanDisplayName(incoming);
  const c = normalizeName(cleanCurrent);
  const i = normalizeName(cleanIncoming);
  const initialsC = c.split(' ').filter((t) => t.length === 1).length;
  const initialsI = i.split(' ').filter((t) => t.length === 1).length;
  if (initialsI < initialsC) return cleanIncoming;
  if (initialsI === initialsC && i.length > c.length) return cleanIncoming;
  return cleanCurrent;
}
