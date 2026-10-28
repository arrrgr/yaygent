/**
 * The cycle engine (design section 1):
 *   result cache -> planner -> [scout -> prune -> extract missing -> judge -> lock]* -> cast -> cache -> out
 * The LLM is called only inside extract. Everything else is code.
 */

import { ProviderUnrecoverableError, type Extractor } from '../llm/types.js';
import type { ResultCache } from '../cache/result_cache.js';
import type { ProfileLookup, ProfileScraper } from '../cache/profiles.js';
import { resolveVars, allVarsResolvable, withDerivedInputs, type StrategyV2, type TemplateV2, type VarContext } from '../templates/v2.js';
import type { FetchOptions, FetchResult, PageCacheHook, SearchOptions, SearchResult } from './browser_deps.js';
import { castRecord, type CastFailure } from './cast.js';
import { entityMissing, lockedValues, mergeEntity, type EntityLock, type EntityState } from './entities.js';
import { formatEvidence, pageEvidence, searchEvidence, type EvidenceItem } from './evidence.js';
import { runExtraction, type ExtractionOutcome } from './extract.js';
import { companyTokensFor, isAmbiguousCompanyName, judgeAll, linkedinHeadlineVerified, linkedinSlug, parseLinkedinTitle, roleMatches, snippetMentionsCompany, type JudgeContext, type PriorCandidate, type Verdict } from './judge.js';
import type { AgentStep } from './loop.js';
import type { Decider } from '../llm/jev.js';
import { nameTokens } from './names.js';

/**
 * How many entities a `per_entity` strategy fans out to, and how many are
 * checked for completeness. Both are now `entity.max` from the template: the
 * old module constant of 2 meant a third founder was never searched for AND
 * never checked, so a row could report `completed` while carrying a founder
 * with `linkedin_url: null` (review 1.7).
 */
function entityCap(s: RunState): number {
  return s.template.entity?.max ?? 0;
}

const VISIT_BUDGET_MS = 20_000;
const SNIPPET_PREVIEW_CHARS = 1500;

export interface CycleDeps {
  search: (query: string, opts?: SearchOptions) => Promise<SearchResult[]>;
  fetchPage: (url: string, opts?: FetchOptions) => Promise<FetchResult>;
  discoverAndFetch: (fromUrl: string, follow: string[], opts?: FetchOptions) => Promise<FetchResult & { discovered_url?: string }>;
  prune: (markdown: string, question?: string, maxChars?: number) => string;
  extractor: Extractor;
  profiles?: ProfileLookup;
  scrapeProfiles?: ProfileScraper;
  /** Jev label classifier for the `jev` strategy; unset = the strategy is skipped */
  decide?: Decider;
  resultCache?: ResultCache;
  pageCache?: PageCacheHook;
  codeVersion?: string;
  now?: () => number;
}

export interface CycleOptions {
  /** overrides template.cycles (request max_turns) */
  cycles?: number;
}

export type StopReason =
  | 'complete'
  | 'cycles'
  | 'wall'
  | 'cost'
  /** search/visit budget spent - distinct from having run out of ideas */
  | 'budget'
  | 'strategies_exhausted'
  /** the extractor provider failed in a way no retry or strategy can fix */
  | 'provider_error';

export interface LockMeta {
  conf: number;
  source_url: string;
  verified_by?: string;
  quote: string;
  cycle: number;
}

export interface CandidateMeta {
  value: unknown;
  source_url: string;
  conf: number;
  reason?: string;
  cycle: number;
}

export interface CycleMeta {
  cycles: number;
  strategies_run: Array<{ index: number; type: string; entity?: string; evidence: number; locked: string[] }>;
  locked: Record<string, LockMeta>;
  candidates: Record<string, CandidateMeta[]>;
  cast_failures: CastFailure[];
  cache: { result_hit: boolean; page_hits: number };
  cost_usd: number;
  cost_basis: 'api' | 'subscription';
  tokens: { in: number; out: number };
  bytes_by_tier: Record<string, number>;
  tier_reached: string[];
  elapsed_ms: number;
  model_confidence: Record<string, number>;
  stop_reason: StopReason;
  budget: { searches_used: number; visits_used: number };
  complete: boolean;
  profile_scrapes?: string[];
}

export interface CycleResult {
  status: 'completed' | 'partial';
  data: Record<string, unknown>;
  _meta: CycleMeta;
  steps: AgentStep[];
  turns: number;
  cost_usd: number;
  elapsed_ms: number;
  model: string;
}

interface RunState {
  template: TemplateV2;
  inputs: Record<string, string>;
  deps: CycleDeps;
  /** every personal /in/ URL seen in search evidence, in order of appearance */
  seenLinkedin: string[];
  started: number;
  steps: AgentStep[];
  meta: CycleMeta;
  flatLocked: Record<string, EntityLock>;
  flatCandidates: Record<string, Verdict[]>;
  entities: EntityState[];
  prior: Record<string, PriorCandidate[]>;
  judgeBase: Omit<JudgeContext, 'priorCandidates'>;
  cyclesRun: number;
  maxCycles: number;
  /** LinkedIn slugs a profile scrape proved are not at this company - never lock them */
  rejectedSlugs: Set<string>;
}

function now(deps: CycleDeps): number {
  return deps.now ? deps.now() : Date.now();
}

function requiredFieldNames(t: TemplateV2): string[] {
  return Object.values(t.fields).filter((f) => f.required).map((f) => f.name);
}

// ---------------------------------------------------------------------------
// Completeness + applicability (the planner)
// ---------------------------------------------------------------------------

function isComplete(s: RunState): boolean {
  const required = requiredFieldNames(s.template);
  const entity = s.template.entity;
  if (!entity) return required.every((f) => f in s.flatLocked);
  if (s.entities.length < entity.min) return false;
  // EVERY returned entity, not the first two: a third founder with a null
  // required field used to be invisible to completeness (review 1.7).
  return s.entities.every((e) => entityMissing(e, required).length === 0);
}

function needsSatisfied(needs: string[] | undefined, s: RunState, entity?: EntityState): boolean {
  if (!needs || needs.length === 0) return true;
  const ename = s.template.entity?.name;
  return needs.every((need) => {
    if (ename && need.startsWith(`${ename}.`)) {
      const field = need.slice(ename.length + 1);
      if (entity) return field in entity.locked;
      return s.entities.some((e) => field in e.locked);
    }
    if (need in s.flatLocked) return true;
    return Boolean(s.inputs[need]);
  });
}

/** Fields this strategy should extract right now; empty = not applicable. */
function targetFields(strategy: StrategyV2, s: RunState, entity?: EntityState): string[] {
  const spec = s.template.entity;
  if (!spec) return strategy.for.filter((f) => !(f in s.flatLocked));
  if (entity) return strategy.for.filter((f) => !(f in entity.locked));
  // entity-level strategy: applicable while we still want more entities, or any
  // capped entity lacks one of the fields (the key is included so new entities can be created)
  const wantMore = s.entities.length < spec.min;
  const someMissing = s.entities.some((e) => strategy.for.some((f) => !(f in e.locked)));
  if (!wantMore && !someMissing) return [];
  return [...new Set([spec.key, ...strategy.for])];
}

function entitiesForFanout(strategy: StrategyV2, index: number, s: RunState): EntityState[] {
  return s.entities
    .slice(0, entityCap(s))
    .filter((e) => !e.tried.has(index))
    .filter((e) => targetFields(strategy, s, e).length > 0)
    .filter((e) => needsSatisfied(strategy.needs, s, e));
}

function varContext(s: RunState, entity?: EntityState): VarContext {
  const locked: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.flatLocked)) locked[k] = String(v.value);
  return {
    inputs: s.inputs,
    locked,
    entity: entity && s.template.entity ? { name: s.template.entity.name, values: lockedValues(entity) } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Scout
// ---------------------------------------------------------------------------

interface ScoutOutcome {
  evidence: EvidenceItem[];
  step: AgentStep;
  usedSearch: boolean;
  usedVisit: boolean;
}

function remainingWallMs(s: RunState): number {
  return s.template.budget.wall_ms - (now(s.deps) - s.started);
}

function recordFetch(s: RunState, res: FetchResult): void {
  for (const [tier, bytes] of Object.entries(res.bytes_by_tier ?? {})) {
    s.meta.bytes_by_tier[tier] = (s.meta.bytes_by_tier[tier] ?? 0) + bytes;
  }
  if (res.tier && !s.meta.tier_reached.includes(res.tier)) s.meta.tier_reached.push(res.tier);
  if (res.cached) s.meta.cache.page_hits++;
}

/**
 * Candidate /in/ URLs for a profile_scrape: rejected linkedin_url candidates first (they were
 * proposed for a person but failed the snippet checks), then any /in/ URL seen in search
 * results. Already-locked URLs and already-scraped URLs are skipped.
 */
export function candidateLinkedinUrls(s: RunState, max: number): string[] {
  const locked = new Set<string>();
  for (const e of s.entities) {
    const u = e.locked['linkedin_url']?.value;
    if (typeof u === 'string') locked.add(linkedinSlug(u));
  }
  const done = new Set((s.meta.profile_scrapes ?? []).map(linkedinSlug));
  const out: string[] = [];
  const taken = new Set<string>();
  const push = (u: unknown) => {
    if (typeof u !== 'string' || !/linkedin\.com\/in\//i.test(u)) return;
    const key = linkedinSlug(u);
    if (!key || locked.has(key) || done.has(key) || taken.has(key)) return;
    taken.add(key);
    out.push(u);
  };
  for (const [k, list] of Object.entries(s.meta.candidates)) {
    // a flat template's rejected candidates are keyed `linkedin_url` with no
    // entity prefix, and used to be invisible here (review 2.12)
    if (k !== 'linkedin_url' && !k.endsWith('.linkedin_url')) continue;
    for (const c of list) push(c.value);
  }
  for (const u of s.seenLinkedin) push(u);
  return out.slice(0, max);
}

/**
 * xray (research-ops-kit's decision-maker ladder): ONE LinkedIn search for the role at the company,
 * candidates whose SERP title already names the company checked first, each scraped (cache first)
 * until one passes: a current job here (employer page website = our domain when it lists one) and
 * the role in the current title. Only passing profiles become evidence, so a miss costs one search
 * plus up to `max` profile reads and hands the row to the slower strategies below it.
 */
async function scoutXray(strategy: StrategyV2, s: RunState, ctx: VarContext, started: number): Promise<ScoutOutcome | null> {
  if (!s.deps.scrapeProfiles) return null;
  const q = strategy.q ?? '';
  if (!allVarsResolvable(q, ctx)) return null;
  const query = resolveVars(q, ctx);
  if (!query) return null;
  const results = await s.deps.search(query, { num: 10 });
  const role = s.template.entity?.role_pattern;
  const ranked: Array<{ url: string; rank: number }> = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (!/linkedin\.com\/in\//i.test(r.url)) continue;
    if (!s.seenLinkedin.includes(r.url)) s.seenLinkedin.push(r.url);
    const slug = linkedinSlug(r.url);
    if (!slug || seen.has(slug) || s.rejectedSlugs.has(slug)) continue;
    seen.add(slug);
    const parsed = parseLinkedinTitle(r.title);
    if (!roleMatches(`${parsed?.headline ?? ''} ${r.snippet ?? ''}`, role)) continue;
    const named = snippetMentionsCompany({ ref: '', kind: 'search', url: r.url, title: parsed?.headline ?? '', text: '' }, s.judgeBase.companyTokens);
    ranked.push({ url: r.url, rank: (named ? 0 : 10) + ranked.length });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  const done = (s.meta.profile_scrapes ??= []);
  const evidence: EvidenceItem[] = [];
  for (const c of ranked.slice(0, strategy.max ?? 4)) {
    if (remainingWallMs(s) <= 1000) break;
    const got = await s.deps.scrapeProfiles([c.url], s.judgeBase.domain, s.judgeBase.companyTokens, {
      budgetMs: Math.max(0, remainingWallMs(s)),
    });
    const item = got[0];
    if (!item) continue;
    done.push(c.url);
    if (item.domain === s.judgeBase.domain && linkedinHeadlineVerified(item, judgeCtx(s))) {
      evidence.push({ ...item, ref: `[${evidence.length + 1}]` });
      break;
    }
    // Not blocked for later strategies: failing THIS gate (role not in the tied job's title, say)
    // is not proof the person is unrelated. Only confirmLinkedin's no-tie verdict blocks a slug.
  }
  return {
    evidence,
    usedSearch: true,
    usedVisit: false,
    step: {
      type: 'search',
      query,
      results_count: results.length,
      snippets: formatEvidence(evidence).slice(0, SNIPPET_PREVIEW_CHARS),
      elapsed_ms: now(s.deps) - started,
    },
  };
}

async function scout(strategy: StrategyV2, s: RunState, entity?: EntityState): Promise<ScoutOutcome | null> {
  const ctx = varContext(s, entity);
  const started = now(s.deps);

  if (strategy.type === 'profile_cache') {
    if (!s.deps.profiles) return null;
    const evidence = await s.deps.profiles(s.inputs['domain'] ?? '', s.inputs['company_linkedin_url']);
    return {
      evidence,
      usedSearch: false,
      usedVisit: false,
      step: {
        type: 'profile_cache',
        query: s.inputs['domain'],
        results_count: evidence.length,
        snippets: formatEvidence(evidence).slice(0, SNIPPET_PREVIEW_CHARS),
        elapsed_ms: now(s.deps) - started,
      },
    };
  }

  if (strategy.type === 'profile_scrape') {
    if (!s.deps.scrapeProfiles) return null;
    const urls = candidateLinkedinUrls(s, strategy.max ?? 2);
    if (urls.length === 0) return null;
    const evidence = await s.deps.scrapeProfiles(urls, s.inputs['domain'] ?? '', s.judgeBase.companyTokens, {
      budgetMs: Math.max(0, remainingWallMs(s)),
    });
    // Only the URLs the scrape actually came back with are retired. Marking all
    // of them up front meant one transient Apify 5xx permanently retired those
    // candidates for the row (review 2.9).
    const scraped = new Set(evidence.map((e) => linkedinSlug(e.url)));
    const done = (s.meta.profile_scrapes ??= []);
    for (const u of urls) if (scraped.has(linkedinSlug(u))) done.push(u);
    return {
      evidence,
      usedSearch: false,
      usedVisit: true,
      step: {
        type: 'profile_scrape',
        query: urls.join(' '),
        results_count: evidence.length,
        snippets: formatEvidence(evidence).slice(0, SNIPPET_PREVIEW_CHARS),
        elapsed_ms: now(s.deps) - started,
      },
    };
  }

  if (strategy.type === 'xray') return scoutXray(strategy, s, ctx, started);

  if (strategy.type === 'search') {
    const q = strategy.q ?? '';
    if (!allVarsResolvable(q, ctx)) return null;
    const query = resolveVars(q, ctx);
    if (!query) return null;
    const results = await s.deps.search(query, {
      gl: strategy.gl,
      hl: strategy.hl,
      num: 10,
      type: strategy.search_type,
      recency: strategy.recency,
    });
    const evidence = searchEvidence(results, new Date(now(s.deps)));
    for (const r of results) {
      if (/linkedin\.com\/in\//i.test(r.url) && !s.seenLinkedin.includes(r.url)) s.seenLinkedin.push(r.url);
    }
    return {
      evidence,
      usedSearch: true,
      usedVisit: false,
      step: {
        type: 'search',
        query,
        results_count: results.length,
        snippets: formatEvidence(evidence).slice(0, SNIPPET_PREVIEW_CHARS),
        elapsed_ms: now(s.deps) - started,
      },
    };
  }

  // visit | visit_discover
  const template = strategy.type === 'visit' ? strategy.url ?? '' : strategy.from ?? '';
  if (!allVarsResolvable(template, ctx)) return null;
  const url = resolveVars(template, ctx);
  if (!url) return null;
  const question = strategy.question ? resolveVars(strategy.question, ctx) : undefined;
  const fetchOpts: FetchOptions = {
    question,
    budgetMs: Math.max(1000, Math.min(VISIT_BUDGET_MS, remainingWallMs(s))),
    jsRequired: strategy.js_required,
    cache: s.deps.pageCache,
  };
  const res =
    strategy.type === 'visit'
      ? await s.deps.fetchPage(url, fetchOpts)
      : await s.deps.discoverAndFetch(url, strategy.follow ?? [], fetchOpts);
  recordFetch(s, res);
  const finalUrl = (res as { discovered_url?: string }).discovered_url ?? res.url_final ?? url;
  const pruned = res.ok ? s.deps.prune(res.markdown, question, 4000) : '';
  const evidence = pruned ? pageEvidence(finalUrl, pruned) : [];
  return {
    evidence,
    usedSearch: false,
    usedVisit: true,
    step: {
      type: res.ok ? 'visit' : 'error',
      url: finalUrl,
      question,
      chars_read: pruned.length,
      snippets: pruned.slice(0, SNIPPET_PREVIEW_CHARS),
      tier: res.tier,
      cached: res.cached,
      elapsed_ms: now(s.deps) - started,
      reasoning: res.ok ? undefined : res.error,
    },
  };
}

// ---------------------------------------------------------------------------
// Judge + lock
// ---------------------------------------------------------------------------

/**
 * `subjectName` is who the candidates are about. Corroboration is only allowed
 * between two sources saying the same thing about the SAME person: keying
 * `prior` by field name alone made "Co-Founder" on one host corroborate
 * "Co-Founder" about a different person on another host, and that +0.1 is what
 * carries a tier-0.6 snippet over the 0.7 threshold (review 1.5).
 */
function judgeCtx(s: RunState, entity?: EntityState, subjectName?: string): JudgeContext {
  const subject = subjectName ?? entity?.display;
  return { ...s.judgeBase, priorCandidates: s.prior, entityName: entity?.display, subjectName: subject };
}

function rememberPrior(s: RunState, v: Verdict, subjectName?: string): void {
  if (!v.ok) return;
  const list = (s.prior[v.field] ??= []);
  list.push({ value: v.value, host: v.host, subject: subjectName });
}

function metaKey(s: RunState, field: string, entity?: EntityState): string {
  if (!entity || !s.template.entity) return field;
  const idx = s.entities.indexOf(entity);
  return `${s.template.entity.name}[${idx}].${field}`;
}

function recordCandidate(s: RunState, v: Verdict, entity?: EntityState): void {
  const key = metaKey(s, v.field, entity);
  (s.meta.candidates[key] ??= []).push({
    value: v.value,
    source_url: v.source_url,
    conf: v.conf,
    reason: v.locked ? undefined : v.reason ?? 'below threshold',
    cycle: s.cyclesRun,
  });
  const bucket = entity ? entity.candidates : s.flatCandidates;
  (bucket[v.field] ??= []).push(v);
}

function lockVerdict(s: RunState, v: Verdict, entity?: EntityState): boolean {
  const target = entity ? entity.locked : s.flatLocked;
  if (v.field in target) return false; // never unlock or overwrite
  if (s.template.fields[v.field]?.type === 'linkedin_person_url' && s.rejectedSlugs.has(linkedinSlug(String(v.value)))) return false;
  target[v.field] = {
    value: v.value,
    quote: v.quote,
    source_url: v.source_url,
    conf: v.conf,
    verified_by: v.verified_by,
    cycle: s.cyclesRun,
  };
  const key = metaKey(s, v.field, entity);
  s.meta.locked[key] = { conf: v.conf, source_url: v.source_url, verified_by: v.verified_by, quote: v.quote, cycle: s.cyclesRun };
  if (v.model_confidence !== undefined) s.meta.model_confidence[key] = v.model_confidence;
  return true;
}

function applyVerdicts(s: RunState, verdicts: Verdict[], entity?: EntityState): { locked: string[]; rejected: Array<{ field: string; reason: string }> } {
  const locked: string[] = [];
  const rejected: Array<{ field: string; reason: string }> = [];
  const target = entity ? entity.locked : s.flatLocked;
  for (const v of verdicts) {
    rememberPrior(s, v, entity?.display);
    if (v.locked && lockVerdict(s, v, entity)) {
      locked.push(v.field);
      continue;
    }
    // A verdict refused because the field is ALREADY locked is not "below
    // threshold"; filing it that way made `_meta.candidates` lie (review 2.12).
    if (v.field in target) continue;
    recordCandidate(s, v, entity);
    rejected.push({ field: v.field, reason: v.reason ?? `conf ${v.conf} below threshold` });
  }
  return { locked, rejected };
}

function applyEntities(s: RunState, outcome: ExtractionOutcome, evidence: EvidenceItem[]): ReturnType<typeof applyVerdicts> {
  const spec = s.template.entity!;
  const locked: string[] = [];
  const rejected: Array<{ field: string; reason: string }> = [];
  for (const group of outcome.entities) {
    // the group's own name is the subject; entityName stays unset so the key
    // field can still be established from evidence that names this person
    const verdicts = judgeAll(group.fields, evidence, judgeCtx(s, undefined, group.name));
    const keyVerdict = verdicts.find((v) => v.field === spec.key);
    for (const v of verdicts) rememberPrior(s, v, group.name);
    const fromRejected = keyVerdict ? s.rejectedSlugs.has(linkedinSlug(keyVerdict.source_url)) : false;
    if (!keyVerdict || !keyVerdict.locked || fromRejected) {
      // the entity itself is not established; keep everything as candidates
      for (const v of verdicts) {
        (s.meta.candidates[`${spec.name}?.${v.field}`] ??= []).push({
          value: v.value,
          source_url: v.source_url,
          conf: v.conf,
          reason: v.reason ?? (v.field === spec.key ? 'key below threshold' : 'entity key not locked'),
          cycle: s.cyclesRun,
        });
        rejected.push({ field: `${group.name}.${v.field}`, reason: v.reason ?? 'entity key not locked' });
      }
      continue;
    }
    const entity = mergeEntity(s.entities, String(keyVerdict.value), spec.max);
    if (!entity) {
      rejected.push({ field: `${group.name}.${spec.key}`, reason: `entity cap ${spec.max} reached` });
      continue;
    }
    for (const v of verdicts) {
      if (v.locked && lockVerdict(s, v, entity)) {
        locked.push(`${entity.display}.${v.field}`);
        continue;
      }
      if (!(v.field in entity.locked)) {
        recordCandidate(s, v, entity);
        rejected.push({ field: `${entity.display}.${v.field}`, reason: v.reason ?? `conf ${v.conf} below threshold` });
      }
    }
  }
  return { locked, rejected };
}

// ---------------------------------------------------------------------------
// One strategy execution (scout -> extract -> judge)
// ---------------------------------------------------------------------------

function errorStep(s: RunState, index: number, strategy: StrategyV2, message: string, entity?: EntityState): void {
  s.steps.push({
    type: 'error',
    query: strategy.q,
    url: strategy.url ?? strategy.from,
    reasoning: message,
    cycle: s.cyclesRun,
    strategy: index,
    strategy_type: strategy.type,
    entity: entity?.display,
  });
}

async function executeStrategy(s: RunState, index: number, strategy: StrategyV2, entity?: EntityState): Promise<boolean> {
  // Mark the entity tried BEFORE anything can bail out. The old code marked it
  // only on the success path, so a per_entity strategy whose scout returned null
  // (no candidate URLs, an unset APIFY token, an empty {{var}}) was re-picked
  // forever: 60s of 100% CPU with no await that yields to the event loop, which
  // starves every other row's I/O and every timer in the process (review 2.1).
  if (entity) entity.tried.add(index);

  const targets = targetFields(strategy, s, entity);
  if (targets.length === 0) return false;
  if (strategy.type === 'jev') return executeJev(s, index, strategy, targets);

  let scouted: ScoutOutcome | null;
  try {
    scouted = await scout(strategy, s, entity);
  } catch (err) {
    errorStep(s, index, strategy, `scout failed: ${(err as Error).message}`, entity);
    return true;
  }
  if (!scouted) return false;

  if (scouted.usedSearch) s.meta.budget.searches_used++;
  if (scouted.usedVisit) s.meta.budget.visits_used++;

  const step: AgentStep = {
    ...scouted.step,
    cycle: s.cyclesRun,
    strategy: index,
    strategy_type: strategy.type,
    entity: entity?.display,
    fields_targeted: targets,
    locked: [],
    rejected: [],
    cost_usd: 0,
    tokens: { in: 0, out: 0 },
  };
  s.steps.push(step);

  if (s.template.require_mention.length > 0) {
    const before = scouted.evidence.length;
    scouted.evidence = scouted.evidence.filter((e) => mentionsAll(s, e)).map((e, i) => ({ ...e, ref: `[${i + 1}]` }));
    if (scouted.evidence.length < before) step.reasoning = `require_mention dropped ${before - scouted.evidence.length} of ${before}`;
  }
  if (scouted.evidence.length === 0) return true;

  const fields = targets.map((f) => s.template.fields[f]);
  let outcome: ExtractionOutcome;
  try {
    outcome = await runExtraction({
      extractor: s.deps.extractor,
      fields,
      evidence: scouted.evidence,
      entity: s.template.entity,
      entityName: entity?.display,
      subject: subjectLine(s),
    });
  } catch (err) {
    step.type = 'error';
    step.reasoning = `extract failed: ${(err as Error).message}`;
    // A provider-level failure is not something another strategy can route
    // around. Swallowing it produced a `partial` row with empty data, HTTP 200
    // and a 24h cache entry - the exact outcome the fail-fast existed to
    // prevent (review 2.3).
    if (err instanceof ProviderUnrecoverableError) throw err;
    return true;
  }

  s.meta.cost_usd += outcome.usage.cost_usd;
  s.meta.tokens.in += outcome.usage.in;
  s.meta.tokens.out += outcome.usage.out;
  step.cost_usd = outcome.usage.cost_usd;
  step.tokens = { in: outcome.usage.in, out: outcome.usage.out };

  // entity-level extraction creates/merges entities; flat templates and
  // per-entity fan-outs lock straight into their target record
  const applied =
    s.template.entity && !entity
      ? applyEntities(s, outcome, scouted.evidence)
      : applyVerdicts(s, judgeAll(outcome.fields, scouted.evidence, judgeCtx(s, entity)), entity);
  step.locked = applied.locked;
  step.rejected = applied.rejected;
  if (s.template.confirm_linkedin) await confirmLinkedin(s, step);
  s.meta.strategies_run.push({
    index,
    type: strategy.type,
    entity: entity?.display,
    evidence: scouted.evidence.length,
    locked: step.locked ?? [],
  });
  // One line per strategy per row at WORKER_CONCURRENCY 80 is a lot of Railway
  // log volume for data already in `_meta` (review 5).
  console.debug(
    `[cycle] ${s.template.name} s${index} ${strategy.type}${entity ? `/${entity.display}` : ''}: ev ${scouted.evidence.length}, locked ${step.locked?.length ?? 0}`
  );
  return true;
}

const CONFIRMED = 'profile_confirmed';

/**
 * Scrape every LinkedIn URL that only a snippet vouched for. A profile with no job (current or past) at this
 * company (by name, and by the employer page's website when it has one) loses the URL; if the
 * person's NAME also came from that same profile, the whole entity goes. An unreadable profile
 * keeps the snippet verdict - unresolved is not evidence either way.
 */
async function confirmLinkedin(s: RunState, step: AgentStep): Promise<void> {
  const spec = s.template.entity;
  if (!spec || !s.deps.scrapeProfiles) return;
  const urlField = Object.values(s.template.fields).find((f) => f.type === 'linkedin_person_url')?.name;
  if (!urlField) return;
  for (const e of [...s.entities]) {
    const lock = e.locked[urlField];
    if (!lock || lock.verified_by !== 'snippet') continue;
    if (remainingWallMs(s) <= 1000) return;
    const url = String(lock.value);
    const got = await s.deps.scrapeProfiles([url], s.judgeBase.domain, s.judgeBase.companyTokens, {
      budgetMs: Math.max(0, remainingWallMs(s)),
    });
    const item = got[0];
    if (!item) continue;
    (s.meta.profile_scrapes ??= []).push(url);
    const key = metaKey(s, urlField, e);
    if (item.domain === s.judgeBase.domain) {
      lock.verified_by = CONFIRMED;
      if (s.meta.locked[key]) s.meta.locked[key]!.verified_by = CONFIRMED;
      continue;
    }
    const slug = linkedinSlug(url);
    s.rejectedSlugs.add(slug);
    delete e.locked[urlField];
    delete s.meta.locked[key];
    (s.meta.candidates[key] ??= []).push({ value: url, source_url: lock.source_url, conf: 0, reason: 'profile: no job at this company', cycle: s.cyclesRun });
    (step.rejected ??= []).push({ field: `${e.display}.${urlField}`, reason: 'profile: no job at this company' });
    const nameLock = e.locked[spec.key];
    if (nameLock && linkedinSlug(nameLock.source_url) === slug) dropEntity(s, e);
  }
}

/** Remove an entity and re-index the `founder[i].x` keys in _meta that followed it. */
function dropEntity(s: RunState, e: EntityState): void {
  const spec = s.template.entity!;
  const idx = s.entities.indexOf(e);
  if (idx < 0) return;
  s.entities.splice(idx, 1);
  const reindex = <T>(rec: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(rec)) {
      const m = new RegExp(`^${spec.name}\\[(\\d+)\\]\\.(.+)$`).exec(k);
      if (!m) {
        out[k] = v;
        continue;
      }
      const i = Number(m[1]);
      if (i === idx) {
        if (rec === (s.meta.candidates as unknown)) out[`${spec.name}?.${m[2]}`] = v;
        continue;
      }
      out[`${spec.name}[${i > idx ? i - 1 : i}].${m[2]}`] = v;
    }
    return out;
  };
  s.meta.locked = reindex(s.meta.locked);
  s.meta.candidates = reindex(s.meta.candidates);
  s.meta.model_confidence = reindex(s.meta.model_confidence);
}

const JEV_TEXT_CHARS = 5000;

/**
 * research-ops-kit's classification first pass: read the page once, ask Jev for every open enum
 * field that has criteria, lock the labels it is sure of (>= min_confidence, never "unclear"), and
 * leave the rest to the extractor strategies below. No model call, no evidence quote: the lock's
 * source is the page and its confidence is Jev's.
 */
async function executeJev(s: RunState, index: number, strategy: StrategyV2, targets: string[]): Promise<boolean> {
  const fields = targets.map((f) => s.template.fields[f]).filter((f) => f && f.type === 'enum' && f.criteria);
  if (!s.deps.decide || fields.length === 0) return false;
  const ctx = varContext(s);
  const template = strategy.from ?? '';
  if (!allVarsResolvable(template, ctx)) return false;
  const url = resolveVars(template, ctx);
  const started = now(s.deps);
  const res = await s.deps.fetchPage(url, {
    budgetMs: Math.max(1000, Math.min(VISIT_BUDGET_MS, remainingWallMs(s))),
    cache: s.deps.pageCache,
  });
  recordFetch(s, res);
  s.meta.budget.visits_used++;
  const step: AgentStep = {
    type: res.ok ? 'visit' : 'error',
    url: res.url_final || url,
    cycle: s.cyclesRun,
    strategy: index,
    strategy_type: 'jev',
    fields_targeted: fields.map((f) => f.name),
    locked: [],
    rejected: [],
    cost_usd: 0,
    tokens: { in: 0, out: 0 },
    elapsed_ms: 0,
  };
  s.steps.push(step);
  const text = res.ok ? res.markdown.slice(0, JEV_TEXT_CHARS) : '';
  if (text.trim().length < 200) {
    step.reasoning = res.ok ? 'page too thin for jev' : res.error;
    step.elapsed_ms = now(s.deps) - started;
    return true;
  }
  const state = { company: { name: s.inputs['company_name'] ?? '', domain: s.inputs['domain'] ?? '', website_text: text } };
  const questions = Object.fromEntries(
    fields.map((f) => [
      f.name,
      {
        instructions: `Based only on \`company.website_text\`: ${f.desc}`,
        criteria: { ...f.criteria!, unclear: 'The text does not make it clear' },
      },
    ])
  );
  const out = await s.deps.decide(state, questions);
  step.elapsed_ms = now(s.deps) - started;
  if (!out) {
    step.reasoning = 'jev unavailable';
    return true;
  }
  s.meta.cost_usd += out.cost_usd;
  step.cost_usd = out.cost_usd;
  const floor = strategy.min_confidence ?? 0.9;
  const pageUrl = res.url_final || url;
  for (const f of fields) {
    const a = out.answers[f.name];
    const ok = Boolean(a && a.choice !== 'unclear' && f.enum!.includes(a.choice));
    const conf = Number(a?.confidence ?? 0);
    const v: Verdict = {
      field: f.name,
      ok,
      locked: ok && conf >= floor,
      reason: !ok ? 'jev: unclear' : conf < floor ? `jev confidence ${conf} below ${floor}` : undefined,
      value: a?.choice ?? null,
      quote: '',
      source_ref: '',
      source_url: pageUrl,
      host: pageUrl,
      tier: 1,
      conf,
      corroborated: false,
      verified_by: 'jev',
      model_confidence: conf,
    };
    if (v.locked && lockVerdict(s, v)) step.locked!.push(f.name);
    else {
      recordCandidate(s, v);
      step.rejected!.push({ field: f.name, reason: v.reason ?? 'not locked' });
    }
  }
  s.meta.strategies_run.push({ index, type: 'jev', evidence: 1, locked: step.locked ?? [] });
  return true;
}

/** research-ops-kit's podcast answers only counted pages that name the person AND the company. */
function mentionsAll(s: RunState, item: EvidenceItem): boolean {
  // NOT normalizeName: it drops everything after the first comma, which is fine for a name and
  // fatal for a page
  const hay = new Set(
    `${item.title ?? ''} ${item.text}`.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  );
  return s.template.require_mention.every((what) => {
    if (what === 'company') return snippetMentionsCompany(item, s.judgeBase.companyTokens);
    const toks = nameTokens(s.inputs[what] ?? '');
    if (toks.length === 0) return true;
    return hay.has(toks[0]!) && hay.has(toks[toks.length - 1]!);
  });
}

function subjectLine(s: RunState): string {
  const bits: string[] = [];
  if (s.inputs['company_name']) bits.push(`company ${s.inputs['company_name']}`);
  if (s.inputs['domain']) bits.push(`domain ${s.inputs['domain']}`);
  if (s.inputs['locality']) bits.push(`location ${s.inputs['locality']}`);
  if (s.inputs['person_name']) bits.push(`person ${s.inputs['person_name']}`);
  return bits.join(', ');
}

// ---------------------------------------------------------------------------
// Cast + output
// ---------------------------------------------------------------------------

function buildData(s: RunState): Record<string, unknown> {
  const failures = s.meta.cast_failures;
  const spec = s.template.entity;
  if (!spec) {
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.flatLocked)) values[k] = v.value;
    return castRecord(s.template.fields, values, failures);
  }
  const list = s.entities.map((e, i) => {
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.locked)) values[k] = v.value;
    return castRecord(s.template.fields, values, failures, `${spec.name}[${i}].`);
  });
  return { [`${spec.name}s`]: list };
}

/** Did a REQUIRED field fail to cast? `founder[2].linkedin_url` -> `linkedin_url`. */
function requiredCastFailed(s: RunState): boolean {
  if (s.meta.cast_failures.length === 0) return false;
  const required = new Set(requiredFieldNames(s.template));
  return s.meta.cast_failures.some((f) => required.has(f.field.replace(/^.*\./, '')));
}

function budgetStop(s: RunState): StopReason | null {
  if (remainingWallMs(s) <= 0) return 'wall';
  // the cost cap guards billed spend; claude_code cost is list-price accounting on a subscription
  if (s.meta.cost_basis === 'api' && s.meta.cost_usd >= s.template.budget.cost_usd) return 'cost';
  return null;
}

function withinScoutBudget(strategy: StrategyV2, s: RunState): boolean {
  if (strategy.type === 'search' || strategy.type === 'xray') return s.meta.budget.searches_used < s.template.budget.searches;
  if (strategy.type === 'visit' || strategy.type === 'visit_discover' || strategy.type === 'jev') return s.meta.budget.visits_used < s.template.budget.visits;
  return true;
}

/** Would this strategy run right now if its scout budget allowed it? */
function applicable(s: RunState, index: number, strategy: StrategyV2, tried: Set<number>, stalled: Set<number>): boolean {
  if (stalled.has(index)) return false;
  if (strategy.per_entity) return entitiesForFanout(strategy, index, s).length > 0;
  if (tried.has(index)) return false;
  if (targetFields(strategy, s).length === 0) return false;
  return needsSatisfied(strategy.needs, s);
}

function pickNext(s: RunState, tried: Set<number>, stalled: Set<number>): { index: number; strategy: StrategyV2 } | null {
  for (const [index, strategy] of s.template.strategies.entries()) {
    if (!withinScoutBudget(strategy, s)) continue;
    if (applicable(s, index, strategy, tried, stalled)) return { index, strategy };
  }
  return null;
}

/**
 * True when the ONLY thing stopping the planner is the search/visit budget.
 * `strategies_exhausted` used to cover both, so you could not tell a template
 * that ran out of ideas from one that ran out of money (review 2.12).
 */
function blockedByBudget(s: RunState, tried: Set<number>, stalled: Set<number>): boolean {
  return s.template.strategies.some(
    (strategy, index) => !withinScoutBudget(strategy, s) && applicable(s, index, strategy, tried, stalled)
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runCycle(
  template: TemplateV2,
  rawInputs: Record<string, string>,
  deps: CycleDeps,
  opts: CycleOptions = {}
): Promise<CycleResult> {
  const inputs = withDerivedInputs(rawInputs);
  const started = now(deps);
  const codeVersion = deps.codeVersion ?? 'dev';
  const cacheKey = deps.resultCache ? deps.resultCache.key(template, inputs, codeVersion) : undefined;

  if (deps.resultCache && cacheKey) {
    const hit = await deps.resultCache.get(cacheKey);
    if (hit) {
      const meta = { ...(hit.meta as unknown as CycleMeta) };
      meta.cache = { ...(meta.cache ?? { page_hits: 0 }), result_hit: true };
      meta.elapsed_ms = now(deps) - started;
      console.info(`[cycle] ${template.name} result cache hit ${cacheKey}`);
      return {
        status: hit.complete ? 'completed' : 'partial',
        data: hit.data as Record<string, unknown>,
        _meta: meta,
        steps: [],
        turns: 0,
        cost_usd: 0,
        elapsed_ms: meta.elapsed_ms,
        model: deps.extractor.model,
      };
    }
  }

  const domain = inputs['domain'] ?? '';
  const s: RunState = {
    template,
    inputs,
    deps,
    started,
    steps: [],
    meta: {
      cycles: 0,
      strategies_run: [],
      locked: {},
      candidates: {},
      cast_failures: [],
      cache: { result_hit: false, page_hits: 0 },
      cost_usd: 0,
      cost_basis: deps.extractor.provider === 'claude_code' ? 'subscription' : 'api',
      tokens: { in: 0, out: 0 },
      bytes_by_tier: {},
      tier_reached: [],
      elapsed_ms: 0,
      model_confidence: {},
      stop_reason: 'strategies_exhausted',
      budget: { searches_used: 0, visits_used: 0 },
      complete: false,
    },
    flatLocked: {},
    flatCandidates: {},
    seenLinkedin: [],
    entities: [],
    prior: {},
    judgeBase: {
      domain,
      companyTokens: companyTokensFor(inputs['company_core'] ?? '', domain),
      threshold: template.threshold,
      fields: template.fields,
      rolePattern: template.entity?.role_pattern,
      entityKey: template.entity?.key,
      ambiguousName: isAmbiguousCompanyName(inputs['company_core'] ?? '', domain),
    },
    cyclesRun: 0,
    maxCycles: opts.cycles ?? template.cycles,
    rejectedSlugs: new Set(),
  };

  let stop: StopReason | null = null;
  const tried = new Set<number>();
  /** strategies that were picked and produced no work - never pick them again */
  const stalled = new Set<number>();
  let optionalLeft = Math.max(0, template.optional_cycles);
  let providerError: Error | null = null;

  // Planner: each cycle re-scans the ordered list and runs the first untried
  // strategy whose `for` still has unlocked fields and whose `needs` are met.
  // A strategy skipped for unmet needs stays untried and can run later.
  try {
    while (true) {
      const done = isComplete(s);
      if (done && optionalLeft <= 0) {
        stop = 'complete';
        break;
      }
      if (s.cyclesRun >= s.maxCycles) {
        stop = 'cycles';
        break;
      }
      const b = budgetStop(s);
      if (b) {
        stop = b;
        break;
      }

      const next = pickNext(s, tried, stalled);
      if (!next) {
        stop = done ? 'complete' : blockedByBudget(s, tried, stalled) ? 'budget' : 'strategies_exhausted';
        break;
      }
      // every required field is already locked; this cycle is spent on the
      // optional ones and comes out of the template's optional_cycles budget
      if (done) optionalLeft--;
      const { index, strategy } = next;

      if (strategy.per_entity) {
        let ran = false;
        for (const entity of entitiesForFanout(strategy, index, s)) {
          if (!withinScoutBudget(strategy, s) || budgetStop(s)) break;
          ran = (await executeStrategy(s, index, strategy, entity)) || ran;
        }
        if (ran) s.cyclesRun++;
        else stalled.add(index);
        continue;
      }

      tried.add(index);
      const ran = await executeStrategy(s, index, strategy);
      if (!ran) stalled.add(index);
      // profile_cache is free and does not consume a cycle
      if (ran && strategy.type !== 'profile_cache') s.cyclesRun++;
    }
  } catch (err) {
    if (!(err instanceof ProviderUnrecoverableError)) throw err;
    providerError = err;
    stop = 'provider_error';
  }

  if (!stop) stop = isComplete(s) ? 'complete' : 'strategies_exhausted';

  const data = buildData(s);
  // A required field that failed to CAST is null in `data`. Reporting that row
  // as `completed` (and caching it for 30 days) was a lie the suite encoded
  // rather than caught (review 1.6, 2.3).
  const complete = isComplete(s) && !requiredCastFailed(s);
  s.meta.cycles = s.cyclesRun;
  s.meta.stop_reason = stop;
  s.meta.complete = complete;
  s.meta.elapsed_ms = now(deps) - started;

  if (providerError) throw providerError;

  if (deps.resultCache && cacheKey) {
    deps.resultCache.set({
      cache_key: cacheKey,
      template: template.name,
      template_hash: template.template_hash,
      code_version: codeVersion,
      complete,
      data,
      meta: s.meta as unknown as Record<string, unknown>,
    });
  }

  return {
    status: complete ? 'completed' : 'partial',
    data,
    _meta: s.meta,
    steps: s.steps,
    turns: s.cyclesRun,
    cost_usd: s.meta.cost_usd,
    elapsed_ms: s.meta.elapsed_ms,
    model: deps.extractor.model,
  };
}
