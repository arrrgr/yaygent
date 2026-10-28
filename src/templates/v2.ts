/**
 * version: 2 templates - declarative field schema + ordered strategies.
 * Parsing, validation, variable derivation and {{var}} resolution.
 */

import { createHash } from 'crypto';
import { companyCore, sanitizeQueryValue } from '../agent/browser_deps.js';

export type FieldKind = 'extractive' | 'inferential';
export type FieldType =
  | 'string'
  | 'enum'
  | 'bool'
  | 'number'
  | 'url'
  | 'linkedin_person_url'
  | 'date'
  | 'list<string>';
export type StrategyType = 'profile_cache' | 'profile_scrape' | 'xray' | 'jev' | 'search' | 'visit' | 'visit_discover';
export type Recency = '1d' | '1w' | '1m' | '6m' | '1y';

export interface FieldSpecV2 {
  name: string;
  kind: FieldKind;
  type: FieldType;
  required: boolean;
  desc: string;
  enum?: string[];
  /** enum fields: value -> definition, for the `jev` strategy (every enum value must have one) */
  criteria?: Record<string, string>;
  numeric?: { unit: 'usd' | 'count' };
}

export interface StrategyV2 {
  type: StrategyType;
  q?: string;
  url?: string;
  from?: string;
  follow?: string[];
  question?: string;
  for: string[];
  needs?: string[];
  per_entity?: boolean;
  gl?: string;
  hl?: string;
  recency?: Recency;
  search_type?: 'web' | 'news';
  js_required?: boolean;
  /** profile_scrape: how many candidate /in/ URLs to scrape (default 2); xray: how many to check (default 4) */
  max?: number;
  /** jev: lock a label only at or above this confidence (default 0.9); below it the field stays open */
  min_confidence?: number;
}

export interface EntitySpecV2 {
  name: string;
  min: number;
  max: number;
  key: string;
  /**
   * Regex (source string) a person's role must match before they become an entity.
   * Applied to the LinkedIn headline of the evidence item and to the quote that
   * sourced the key field. Undefined = no role gate.
   */
  role_pattern?: string;
}

export interface BudgetV2 {
  searches: number;
  visits: number;
  wall_ms: number;
  cost_usd: number;
}

export interface TemplateV2 {
  version: 2;
  name: string;
  description: string;
  model?: string;
  cache_key: string[];
  cycles: number;
  /**
   * Extra cycles the engine may spend on OPTIONAL fields after every required
   * field is locked. 0 (the default) means "optional" really means "only if a
   * required field happened to be missing when the planner reached it", which is
   * why `company_enrichment`'s news fields were structurally unreachable
   * (review 2.6). Still bounded by budget.searches / visits / wall / cost.
   */
  optional_cycles: number;
  /**
   * Never return a LinkedIn URL that only a search snippet vouched for: scrape the profile and
   * require a current job at this company (employer page website = our domain when it has one).
   */
  confirm_linkedin: boolean;
  /**
   * Evidence items that do not name these subjects never reach the extractor. Each entry is an
   * input variable (person_name: first AND last name tokens) or `company` (company_core / domain label).
   */
  require_mention: string[];
  budget: BudgetV2;
  threshold: number;
  entity?: EntitySpecV2;
  fields: Record<string, FieldSpecV2>;
  strategies: StrategyV2[];
  /** every input the template can consume (declared + derived from strategies) */
  variables: string[];
  /** inputs that must be present on a request */
  required: string[];
  /** sha1 of the canonical template body; part of the result cache key */
  template_hash: string;
}

const FIELD_KINDS: FieldKind[] = ['extractive', 'inferential'];
const FIELD_TYPES: FieldType[] = ['string', 'enum', 'bool', 'number', 'url', 'linkedin_person_url', 'date', 'list<string>'];
const STRATEGY_TYPES: StrategyType[] = ['profile_cache', 'profile_scrape', 'xray', 'jev', 'search', 'visit', 'visit_discover'];
const RECENCIES: Recency[] = ['1d', '1w', '1m', '6m', '1y'];

/** Variables the engine derives from other inputs; never required on a request. */
export const DERIVED_VARIABLES = ['company_core', 'domain'];

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function fail(msg: string): never {
  throw new Error(`Invalid v2 template: ${msg}`);
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function asStringList(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`${what} must be a list`);
  return v.map((x) => String(x));
}

function num(v: unknown, fallback: number, what: string): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} must be a number`);
  return v;
}

export function isV2(obj: unknown): boolean {
  return Boolean(obj) && typeof obj === 'object' && (obj as Record<string, unknown>)['version'] === 2;
}

function parseField(name: string, raw: unknown): FieldSpecV2 {
  const r = asRecord(raw, `fields.${name}`);
  const kind = (r['kind'] ?? 'extractive') as FieldKind;
  if (!FIELD_KINDS.includes(kind)) fail(`fields.${name}.kind must be extractive|inferential`);
  const type = (r['type'] ?? 'string') as FieldType;
  if (!FIELD_TYPES.includes(type)) fail(`fields.${name}.type ${String(type)} is not supported`);
  const spec: FieldSpecV2 = {
    name,
    kind,
    type,
    required: r['required'] === true,
    desc: r['desc'] ? String(r['desc']) : '',
  };
  if (type === 'enum') {
    const values = asStringList(r['enum'], `fields.${name}.enum`);
    if (values.length === 0) fail(`fields.${name} is an enum without values`);
    spec.enum = values;
  }
  if (r['criteria'] !== undefined) {
    if (type !== 'enum') fail(`fields.${name}.criteria is only for enum fields`);
    const c = asRecord(r['criteria'], `fields.${name}.criteria`);
    for (const v of spec.enum ?? []) if (!c[v]) fail(`fields.${name}.criteria is missing ${v}`);
    spec.criteria = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)]));
  }
  if (r['numeric'] !== undefined) {
    const n = asRecord(r['numeric'], `fields.${name}.numeric`);
    const unit = String(n['unit'] ?? '');
    if (unit !== 'usd' && unit !== 'count') fail(`fields.${name}.numeric.unit must be usd|count`);
    spec.numeric = { unit };
  }
  return spec;
}

function parseStrategy(i: number, raw: unknown, fieldNames: Set<string>): StrategyV2 {
  const r = asRecord(raw, `strategies[${i}]`);
  const type = r['type'] as StrategyType;
  if (!STRATEGY_TYPES.includes(type)) fail(`strategies[${i}].type must be one of ${STRATEGY_TYPES.join('|')}`);
  const forFields = asStringList(r['for'], `strategies[${i}].for`);
  if (forFields.length === 0) fail(`strategies[${i}].for must list at least one field`);
  for (const f of forFields) {
    if (!fieldNames.has(f)) fail(`strategies[${i}].for references unknown field ${f}`);
  }
  const s: StrategyV2 = { type, for: forFields };
  if (type === 'search' || type === 'xray') {
    if (!r['q']) fail(`strategies[${i}] (${type}) needs q`);
    s.q = String(r['q']);
  }
  if (type === 'visit') {
    if (!r['url']) fail(`strategies[${i}] (visit) needs url`);
    s.url = String(r['url']);
  }
  if (type === 'jev') {
    if (!r['from']) fail(`strategies[${i}] (jev) needs from`);
    s.from = String(r['from']);
    s.min_confidence = num(r['min_confidence'], 0.9, `strategies[${i}].min_confidence`);
  }
  if (type === 'visit_discover') {
    if (!r['from']) fail(`strategies[${i}] (visit_discover) needs from`);
    s.from = String(r['from']);
    s.follow = asStringList(r['follow'], `strategies[${i}].follow`);
    if (s.follow.length === 0) fail(`strategies[${i}] (visit_discover) needs a follow list`);
  }
  if (r['question'] !== undefined) s.question = String(r['question']);
  if (r['needs'] !== undefined) s.needs = asStringList(r['needs'], `strategies[${i}].needs`);
  if (r['per_entity'] !== undefined) s.per_entity = r['per_entity'] === true;
  if (r['gl'] !== undefined) s.gl = String(r['gl']);
  if (r['hl'] !== undefined) s.hl = String(r['hl']);
  if (r['recency'] !== undefined) {
    const rec = String(r['recency']) as Recency;
    if (!RECENCIES.includes(rec)) fail(`strategies[${i}].recency must be one of ${RECENCIES.join('|')}`);
    s.recency = rec;
  }
  if (r['search_type'] !== undefined) {
    const st = String(r['search_type']);
    if (st !== 'web' && st !== 'news') fail(`strategies[${i}].search_type must be web|news`);
    s.search_type = st;
  }
  if (r['js_required'] !== undefined) s.js_required = r['js_required'] === true;
  if (type === 'profile_scrape') s.max = num(r['max'], 2, `strategies[${i}].max`);
  if (type === 'xray') s.max = num(r['max'], 4, `strategies[${i}].max`);
  return s;
}

/** All {{x}} tokens used in a strategy's text slots. */
export function strategyTokens(s: StrategyV2): string[] {
  const out = new Set<string>();
  for (const text of [s.q, s.url, s.from, s.question]) {
    if (!text) continue;
    for (const m of text.matchAll(VAR_RE)) out.add(m[1]);
  }
  return [...out];
}

/**
 * variables = tokens in strategies that are not produced by a field, not
 * entity-scoped (founder.x), and not engine-derived (company_core, domain
 * from website). `company_core` needs `company_name` (or `domain`).
 */
export function deriveVariables(
  strategies: StrategyV2[],
  fieldNames: Set<string>,
  entityName?: string
): string[] {
  const vars = new Set<string>();
  for (const s of strategies) {
    for (const tok of strategyTokens(s)) {
      if (fieldNames.has(tok)) continue;
      if (entityName && tok.startsWith(`${entityName}.`)) continue;
      if (tok === 'company_core') {
        vars.add('company_name');
        continue;
      }
      vars.add(tok);
    }
  }
  return [...vars];
}

/** Recursively sort object keys so JSON.stringify is stable at every depth. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k]);
    return out;
  }
  return value;
}

/**
 * sha1 of the WHOLE template. This used to be
 * `JSON.stringify(obj, Object.keys(obj).sort())`, where the second argument is a
 * replacer allow-list applied at every depth, not a key order - so editing a
 * strategy query, a field description or any nested value left the hash
 * byte-identical and the result cache kept serving stale rows (review 2.5).
 */
export function templateHash(obj: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(canonicalize(obj))).digest('hex');
}

export function parseTemplateV2(parsed: unknown): TemplateV2 {
  const obj = asRecord(parsed, 'template');
  if (obj['version'] !== 2) fail('version must be 2');
  if (!obj['name']) fail('name is required');

  const fieldsRaw = asRecord(obj['fields'], 'fields');
  const fields: Record<string, FieldSpecV2> = {};
  for (const [name, raw] of Object.entries(fieldsRaw)) fields[name] = parseField(name, raw);
  if (Object.keys(fields).length === 0) fail('fields must declare at least one field');
  const fieldNames = new Set(Object.keys(fields));

  let entity: EntitySpecV2 | undefined;
  if (obj['entity'] !== undefined) {
    const e = asRecord(obj['entity'], 'entity');
    if (!e['name']) fail('entity.name is required');
    const key = String(e['key'] ?? 'full_name');
    if (!fieldNames.has(key)) fail(`entity.key ${key} is not a declared field`);
    entity = {
      name: String(e['name']),
      min: num(e['min'], 1, 'entity.min'),
      max: num(e['max'], 3, 'entity.max'),
      key,
    };
    if (e['role_pattern'] !== undefined) {
      const rp = String(e['role_pattern']);
      try {
        new RegExp(rp, 'i');
      } catch {
        fail(`entity.role_pattern is not a valid regex: ${rp}`);
      }
      entity.role_pattern = rp;
    }
    if (entity.max < 1 || entity.min < 0 || entity.min > entity.max) fail('entity.min/max out of range');
  }

  const strategiesRaw = obj['strategies'];
  if (!Array.isArray(strategiesRaw) || strategiesRaw.length === 0) fail('strategies must be a non-empty list');
  const strategies = strategiesRaw.map((raw, i) => parseStrategy(i, raw, fieldNames));
  for (const [i, s] of strategies.entries()) {
    if (s.per_entity && !entity) fail(`strategies[${i}] is per_entity but the template has no entity`);
    for (const need of s.needs ?? []) {
      const bare = entity && need.startsWith(`${entity.name}.`) ? need.slice(entity.name.length + 1) : need;
      if (!fieldNames.has(bare)) fail(`strategies[${i}].needs references unknown field ${need}`);
    }
  }

  const budgetRaw = obj['budget'] !== undefined ? asRecord(obj['budget'], 'budget') : {};
  const budget: BudgetV2 = {
    searches: num(budgetRaw['searches'], 4, 'budget.searches'),
    visits: num(budgetRaw['visits'], 3, 'budget.visits'),
    wall_ms: num(budgetRaw['wall_ms'], 60_000, 'budget.wall_ms'),
    cost_usd: num(budgetRaw['cost_usd'], 0.02, 'budget.cost_usd'),
  };

  const declared = asStringList(obj['variables'], 'variables');
  const derived = deriveVariables(strategies, fieldNames, entity?.name);
  // company_core is always derived; domain is derived when the template takes website instead
  const domainDerived = declared.includes('website') && !declared.includes('domain');
  const variables = [...new Set([...declared, ...derived])].filter(
    (v) => v !== 'company_core' && !(v === 'domain' && domainDerived)
  );

  const requiredDeclared = obj['required'] !== undefined ? asStringList(obj['required'], 'required') : undefined;
  const required = requiredDeclared ?? [...variables];
  for (const r of required) {
    if (!variables.includes(r)) fail(`required lists ${r}, which is not a variable`);
  }

  const cacheKey = asStringList(obj['cache_key'], 'cache_key');
  for (const k of cacheKey) {
    if (!variables.includes(k) && !DERIVED_VARIABLES.includes(k)) fail(`cache_key lists ${k}, which is not a variable`);
  }

  const threshold = num(obj['threshold'], 0.7, 'threshold');
  if (threshold <= 0 || threshold > 1) fail('threshold must be in (0, 1]');

  const { template_hash: _ignored, ...hashable } = obj;
  void _ignored;

  return {
    version: 2,
    name: String(obj['name']),
    description: obj['description'] ? String(obj['description']) : '',
    model: obj['model'] ? String(obj['model']) : undefined,
    cache_key: cacheKey,
    cycles: num(obj['cycles'], 5, 'cycles'),
    optional_cycles: num(obj['optional_cycles'], 0, 'optional_cycles'),
    confirm_linkedin: obj['confirm_linkedin'] === true,
    require_mention: asStringList(obj['require_mention'], 'require_mention'),
    budget,
    threshold,
    entity,
    fields,
    strategies,
    variables,
    required,
    template_hash: templateHash(hashable),
  };
}

// ---------------------------------------------------------------------------
// {{var}} resolution
// ---------------------------------------------------------------------------

export interface VarContext {
  inputs: Record<string, string>;
  /** locked, non-entity field values */
  locked?: Record<string, string>;
  /** the entity in scope for per_entity strategies (its locked values) */
  entity?: { name: string; values: Record<string, string> };
}

/** Inputs plus engine-derived variables (domain from website, company_core). Inputs win. */
export function withDerivedInputs(inputs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...inputs };
  if (!out['domain'] && out['website']) out['domain'] = domainFromUrl(out['website']);
  if (out['domain']) out['domain'] = domainFromUrl(out['domain']);
  if (!out['company_core'] && (out['company_name'] || out['domain'])) {
    out['company_core'] = companyCore(out['company_name'] ?? '', out['domain']);
  }
  return out;
}

export function domainFromUrl(value: string): string {
  const trimmed = value.trim().toLowerCase();
  try {
    const u = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return trimmed.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? trimmed;
  }
}

function lookupVar(token: string, ctx: VarContext): string | undefined {
  if (ctx.entity && token.startsWith(`${ctx.entity.name}.`)) {
    const key = token.slice(ctx.entity.name.length + 1);
    return ctx.entity.values[key];
  }
  // locked extracted values beat inputs; inputs are never overwritten in ctx
  const locked = ctx.locked?.[token];
  if (locked !== undefined && locked !== '') return locked;
  return ctx.inputs[token];
}

/** True when every {{token}} in the text resolves to a non-empty value. */
export function allVarsResolvable(text: string, ctx: VarContext): boolean {
  for (const m of text.matchAll(VAR_RE)) {
    const v = lookupVar(m[1], ctx);
    if (v === undefined || v === '') return false;
  }
  return true;
}

/**
 * Replace {{tokens}}. Tokens sitting inside a double-quoted phrase get the
 * sanitised value (quotes/ampersands/legal suffixes stripped) so the phrase
 * stays a valid exact-match query.
 */
export function resolveVars(text: string, ctx: VarContext): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(VAR_RE)) {
    const idx = m.index ?? 0;
    out += text.slice(last, idx);
    const value = lookupVar(m[1], ctx) ?? '';
    const quoted = isInsideQuotes(text, idx);
    out += quoted ? sanitizeQueryValue(value) : value;
    last = idx + m[0].length;
  }
  out += text.slice(last);
  return out.replace(/\s+/g, ' ').trim();
}

function isInsideQuotes(text: string, idx: number): boolean {
  let count = 0;
  for (let i = 0; i < idx; i++) if (text[i] === '"') count++;
  return count % 2 === 1;
}
