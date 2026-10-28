import { parseTemplateV2, type TemplateV2 } from '../../src/templates/v2.js';
import type { CycleDeps } from '../../src/agent/cycle.js';
import type { Extractor, ExtractResult, JsonSchema } from '../../src/llm/types.js';
import type { FetchResult, SearchResult } from '../../src/agent/browser_deps.js';

export function foundersTemplate(overrides: Record<string, unknown> = {}): TemplateV2 {
  return parseTemplateV2({
    version: 2,
    name: 'find_founders',
    cache_key: ['domain'],
    cycles: 6,
    budget: { searches: 4, visits: 3, wall_ms: 60000, cost_usd: 0.02 },
    threshold: 0.7,
    variables: ['company_name', 'domain', 'company_linkedin_url', 'locality'],
    required: ['company_name', 'domain'],
    entity: { name: 'founder', min: 1, max: 3, key: 'full_name' },
    fields: {
      full_name: { kind: 'extractive', type: 'string', required: true, desc: 'name' },
      linkedin_url: { kind: 'extractive', type: 'linkedin_person_url', required: true },
      country_of_origin: { kind: 'inferential', type: 'string', required: false },
    },
    strategies: [
      { type: 'profile_cache', for: ['full_name', 'linkedin_url', 'country_of_origin'] },
      { type: 'search', q: '"{{company_core}}" founder site:linkedin.com/in', for: ['full_name', 'linkedin_url'] },
      { type: 'search', q: '{{company_core}} {{domain}} founder OR co-founder', for: ['full_name', 'linkedin_url'] },
      { type: 'visit_discover', from: 'https://{{domain}}', follow: ['about', 'team'], question: 'who founded the company', for: ['full_name'] },
      { type: 'search', q: '"{{founder.full_name}}" {{company_core}} linkedin', for: ['linkedin_url'], needs: ['founder.full_name'], per_entity: true },
      { type: 'search', q: '"{{founder.full_name}}" born OR nationality', for: ['country_of_origin'], needs: ['founder.full_name'], per_entity: true, gl: 'us' },
    ],
    ...overrides,
  });
}

export function flatTemplate(overrides: Record<string, unknown> = {}): TemplateV2 {
  return parseTemplateV2({
    version: 2,
    name: 'classify_vertical',
    cache_key: ['domain'],
    cycles: 3,
    threshold: 0.5,
    variables: ['company_name', 'website'],
    fields: {
      vertical: { kind: 'inferential', type: 'enum', required: true, enum: ['SaaS', 'FinTech', 'Data / AI'] },
      tagline: { kind: 'extractive', type: 'string', required: false },
    },
    strategies: [
      { type: 'search', q: '{{company_core}} {{domain}} what does the company do', for: ['vertical', 'tagline'] },
      { type: 'visit_discover', from: 'https://{{domain}}', follow: ['about'], question: 'what', for: ['vertical', 'tagline'] },
    ],
    ...overrides,
  });
}

export function result(title: string, url: string, snippet: string, date?: string): SearchResult {
  return { title, url, snippet, date, position: 1, source: 'test' };
}

export function fetchOk(url: string, markdown: string, tier = 'direct'): FetchResult {
  return {
    ok: true,
    markdown,
    tier,
    status: 200,
    bytes: markdown.length,
    url_final: url,
    cached: false,
    tiers_tried: [tier],
    bytes_by_tier: { [tier]: markdown.length },
    elapsed_ms: 5,
  };
}

export function fetchFail(url: string): FetchResult {
  return {
    ok: false,
    markdown: '',
    tier: 'direct',
    status: 403,
    bytes: 0,
    url_final: url,
    cached: false,
    error: 'blocked',
    tiers_tried: ['direct', 'proxy'],
    bytes_by_tier: { direct: 0 },
    elapsed_ms: 5,
  };
}

export interface ExtractCall {
  schema: JsonSchema;
  system: string;
  user: string;
}

/**
 * Scripted extractor: `script` is called with the call index and the user
 * prompt and returns the JSON the model would produce.
 */
export function scriptedExtractor(
  script: (i: number, call: ExtractCall) => unknown,
  costPerCall = 0.001
): Extractor & { calls: ExtractCall[] } {
  const calls: ExtractCall[] = [];
  return {
    provider: 'openrouter',
    model: 'test-model',
    calls,
    async extract(schema, system, user): Promise<ExtractResult> {
      const call = { schema, system, user };
      calls.push(call);
      const json = script(calls.length - 1, call);
      return { json, raw: JSON.stringify(json), usage: { in: 100, out: 20, cost_usd: costPerCall } };
    },
  };
}

export function baseDeps(extractor: Extractor, overrides: Partial<CycleDeps> = {}): CycleDeps {
  return {
    search: async () => [],
    fetchPage: async (url) => fetchFail(url),
    discoverAndFetch: async (url) => fetchFail(url),
    prune: (md, _q, max = 4000) => md.slice(0, max),
    extractor,
    codeVersion: 'test',
    ...overrides,
  };
}

export function field(value: unknown, quote: string, source_ref: string, confidence = 0.9): Record<string, unknown> {
  return { value, quote, source_ref, confidence };
}

export function nullField(): Record<string, unknown> {
  return { value: null, quote: null, source_ref: null, confidence: null };
}
