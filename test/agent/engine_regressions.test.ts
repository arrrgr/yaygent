/**
 * Regression tests for REVIEW_v2_engine.md sections 2 and 3 - budget, cache,
 * planner, provider and route defects. Every test here fails on the
 * pre-review engine.
 */

import { describe, expect, it } from 'vitest';
import { runCycle } from '../../src/agent/cycle.js';
import { parseTemplateV2, templateHash } from '../../src/templates/v2.js';
import {
  RESULT_CACHE_GET_SQL,
  RESULT_TTL_COMPLETE_MS,
  RESULT_TTL_COMPLETE_SECONDS,
  resultCacheKey,
  type CachedResult,
  type ResultCache,
} from '../../src/cache/result_cache.js';
import { getTemplateAny, getTemplateV2, isValidTemplateName, saveTemplate, templateExists } from '../../src/templates/store.js';
import { Semaphore } from '../../src/llm/claude_code.js';
import { ProviderUnrecoverableError } from '../../src/llm/types.js';
import { baseDeps, field, foundersTemplate, flatTemplate, nullField, result, scriptedExtractor } from './helpers.js';

const INPUTS = { company_name: 'Acme Inc', domain: 'acme.com' };

function spyCache(): ResultCache & { written: Array<Omit<CachedResult, 'created_at'>> } {
  const written: Array<Omit<CachedResult, 'created_at'>> = [];
  const store = new Map<string, CachedResult>();
  return {
    written,
    key: resultCacheKey,
    get: async (k) => store.get(k) ?? null,
    set: (e) => {
      written.push(e);
      store.set(e.cache_key, { ...e, created_at: 'now' });
    },
  };
}

// ---------------------------------------------------------------------------
// 2.1 - a per-entity strategy whose scout returns null used to spin at 100% CPU
// ---------------------------------------------------------------------------

describe('2.1 per-entity strategy that makes no progress', () => {
  const spinTemplate = parseTemplateV2({
    version: 2,
    name: 'spin',
    threshold: 0.7,
    cycles: 20,
    budget: { searches: 10, visits: 10, wall_ms: 5000, cost_usd: 1 },
    variables: ['company_name', 'domain'],
    entity: { name: 'founder', min: 1, max: 2, key: 'full_name' },
    fields: {
      full_name: { kind: 'extractive', type: 'string', required: true },
      linkedin_url: { kind: 'extractive', type: 'linkedin_person_url', required: true },
    },
    strategies: [
      { type: 'search', q: '{{company_core}} founder', for: ['full_name', 'linkedin_url'] },
      // scout returns null for every entity: no scrapeProfiles dep is wired
      { type: 'profile_scrape', max: 2, for: ['linkedin_url'], needs: ['founder.full_name'], per_entity: true },
    ],
  });

  it('is tried once per entity and then abandoned, instead of looping to the wall', async () => {
    let clock = 0;
    let nowCalls = 0;
    const now = () => {
      nowCalls++;
      return (clock += 1);
    };
    // Platform9, not Acme: a 4-letter company core is an "ambiguous name", which
    // caps a third-party snippet at 0.65 so the entity would never be created
    // and the per_entity strategy would never engage at all.
    const inputs = { company_name: 'Platform9 Systems', domain: 'platform9.com' };
    const search = async () => [
      result(
        'Ann Rivers - Co-founder - Platform9 | LinkedIn',
        'https://www.linkedin.com/in/ann-rivers',
        'Ann Rivers. Co-founder at Platform9.'
      ),
    ];
    const extractor = scriptedExtractor(() => ({
      entities: [{ full_name: field('Ann Rivers', 'Ann Rivers. Co-founder at Platform9.', '[1]'), linkedin_url: nullField() }],
    }));

    const res = await runCycle(spinTemplate, inputs, baseDeps(extractor, { search, now }));

    // before the fix: stop_reason 'wall' after burning the whole 5s budget
    expect(res._meta.stop_reason).toBe('strategies_exhausted');
    expect(res.status).toBe('partial');
    expect(nowCalls).toBeLessThan(60);
    // the scout never produced evidence, so it never became a strategies_run entry
    expect(res._meta.strategies_run.map((s) => s.index)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// 1.7 - completeness must look at every entity that is returned
// ---------------------------------------------------------------------------

describe('1.7 a third entity missing a required field blocks `completed`', () => {
  it('reports partial when founder 3 has no linkedin_url', async () => {
    const urls: Record<string, string> = {
      'A One': 'https://www.linkedin.com/in/a-one',
      'B Two': 'https://www.linkedin.com/in/b-two',
    };
    const search = async (q: string) => {
      if (q.includes('founder OR co-founder')) {
        return [result('Team', 'https://acme.com/team', 'Founded by A One, B Two and C Three.')];
      }
      for (const [name, url] of Object.entries(urls)) {
        if (q.includes(name)) return [result(`${name} - Co-founder - Acme | LinkedIn`, url, `${name}. Co-founder at Acme. ${url}`)];
      }
      return [];
    };
    const extractor = scriptedExtractor((_i, call) => {
      if (call.user.includes('acme.com/team')) {
        return {
          entities: ['A One', 'B Two', 'C Three'].map((n) => ({
            full_name: field(n, 'Founded by A One, B Two and C Three.', '[1]'),
            linkedin_url: nullField(),
          })),
        };
      }
      for (const [name, url] of Object.entries(urls)) {
        if (call.user.includes(`about one founder: ${name}`)) {
          return { fields: { linkedin_url: field(url, `${name} - Co-founder - Acme | LinkedIn | ${url}`, '[1]') } };
        }
      }
      return { fields: { linkedin_url: nullField() } };
    });

    const t = foundersTemplate({ budget: { searches: 10, visits: 3, wall_ms: 60000, cost_usd: 1 }, cycles: 10 });
    const res = await runCycle(t, INPUTS, baseDeps(extractor, { search }));

    const founders = res.data['founders'] as Array<Record<string, unknown>>;
    expect(founders.length).toBe(3);
    expect(founders[2]['linkedin_url']).toBeNull();
    // before the fix isComplete only looked at the first PER_ENTITY_CAP = 2
    expect(res.status).toBe('partial');
    expect(res._meta.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1.6 / 2.3 - `completed` must mean the required fields survived the cast, and
// a provider failure must not be cached
// ---------------------------------------------------------------------------

describe('1.6 a failed cast on a required field demotes the row', () => {
  it('reports partial and caches complete: false', async () => {
    const search = async () => [result('Acme', 'https://www.g2.com/acme', 'Acme is a SaaS payments platform for developers.')];
    const extractor = scriptedExtractor(() => ({
      fields: { vertical: field('Banana', 'Acme is a SaaS payments platform', '[1]'), tagline: nullField() },
    }));
    const t = flatTemplate({
      fields: { vertical: { kind: 'inferential', type: 'enum', required: true, enum: ['SaaS', 'FinTech'] } },
      strategies: [{ type: 'search', q: '{{company_core}} {{domain}} what', for: ['vertical'] }],
    });
    const cache = spyCache();
    const res = await runCycle(t, { company_name: 'Acme', website: 'acme.com' }, baseDeps(extractor, { search, resultCache: cache }));

    expect(res._meta.locked['vertical'].conf).toBeCloseTo(0.54, 4);
    expect(res.data['vertical']).toBeNull();
    expect(res._meta.cast_failures.length).toBe(1);
    // before the fix: status 'completed' and a 30-day cache entry for a null field
    expect(res.status).toBe('partial');
    expect(res._meta.complete).toBe(false);
    expect(cache.written[0]?.complete).toBe(false);
  });

  it('an optional field that fails to cast does not demote the row', async () => {
    const search = async () => [result('Acme', 'https://acme.com/x', 'Acme is a SaaS payments platform. Tagline: Banana.')];
    const extractor = scriptedExtractor(() => ({
      fields: {
        vertical: field('SaaS', 'Acme is a SaaS payments platform', '[1]'),
        maybe: field('Banana', 'Tagline: Banana.', '[1]'),
      },
    }));
    const t = flatTemplate({
      fields: {
        vertical: { kind: 'inferential', type: 'enum', required: true, enum: ['SaaS', 'FinTech'] },
        maybe: { kind: 'inferential', type: 'enum', required: false, enum: ['Yes', 'No'] },
      },
      strategies: [{ type: 'search', q: '{{company_core}} {{domain}} what', for: ['vertical', 'maybe'] }],
    });
    const res = await runCycle(t, { company_name: 'Acme', website: 'acme.com' }, baseDeps(extractor, { search }));
    expect(res._meta.cast_failures.map((f) => f.field)).toEqual(['maybe']);
    expect(res.status).toBe('completed');
  });
});

describe('2.3 a provider-level failure aborts the row and is never cached', () => {
  it('rethrows and writes nothing to the result cache', async () => {
    const search = async () => [result('x', 'https://example.com/x', 'nothing useful here')];
    const extractor = scriptedExtractor(() => {
      throw new ProviderUnrecoverableError('claude_code', '[llm] claude_code: subscription limit reached - resets 2pm');
    });
    const cache = spyCache();
    await expect(runCycle(flatTemplate(), { company_name: 'Acme', website: 'acme.com' }, baseDeps(extractor, { search, resultCache: cache })))
      .rejects.toThrow(/subscription limit/i);
    // before the fix this resolved as a `partial` row with empty data and a 24h cache entry
    expect(cache.written).toEqual([]);
  });

  it('carries a 4xx status so the batch runner does not retry it', () => {
    expect(new ProviderUnrecoverableError('claude_code', 'x').statusCode).toBe(429);
  });

  it('an ordinary extractor error still just becomes an error step', async () => {
    const search = async () => [result('x', 'https://example.com/x', 'nothing useful here')];
    const extractor = scriptedExtractor(() => {
      throw new Error('llm down');
    });
    const res = await runCycle(flatTemplate(), { company_name: 'Acme', website: 'acme.com' }, baseDeps(extractor, { search }));
    expect(res.status).toBe('partial');
    expect(res.steps.some((s) => s.reasoning?.includes('llm down'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2.4 - the DB result cache read
// ---------------------------------------------------------------------------

describe('2.4 result cache TTL binding', () => {
  it('binds a value that fits in int4', () => {
    const INT4_MAX = 2_147_483_647;
    // the old code bound RESULT_TTL_COMPLETE_MS directly as ::int
    expect(RESULT_TTL_COMPLETE_MS).toBeGreaterThan(INT4_MAX);
    expect(RESULT_TTL_COMPLETE_SECONDS).toBeLessThanOrEqual(INT4_MAX);
    expect(RESULT_TTL_COMPLETE_SECONDS).toBe(2_592_000);
  });

  it('no longer multiplies an interval by a millisecond count', () => {
    expect(RESULT_CACHE_GET_SQL).toContain('make_interval(secs => $2::int)');
    expect(RESULT_CACHE_GET_SQL).not.toContain("interval '1 millisecond'");
  });
});

// ---------------------------------------------------------------------------
// 2.5 - the template hash must see nested edits
// ---------------------------------------------------------------------------

describe('2.5 templateHash covers the whole template', () => {
  const base = {
    version: 2,
    name: 'h',
    cycles: 5,
    threshold: 0.7,
    entity: { name: 'founder', min: 1, max: 3, key: 'full_name', role_pattern: '\\bfounder\\b' },
    budget: { searches: 4, visits: 3, wall_ms: 60000, cost_usd: 0.02 },
    fields: { full_name: { kind: 'extractive', type: 'string', required: true, desc: 'the name' } },
    strategies: [{ type: 'search', q: '{{company_core}} founder', for: ['full_name'] }],
  };

  const edits: Array<[string, Record<string, unknown>]> = [
    ['a strategy query', { strategies: [{ type: 'search', q: '{{company_core}} co-founder', for: ['full_name'] }] }],
    ['a field description', { fields: { full_name: { kind: 'extractive', type: 'string', required: true, desc: 'the full name' } } }],
    ['entity.role_pattern', { entity: { ...base.entity, role_pattern: '\\b(founder|owner)\\b' } }],
    ['a budget number', { budget: { ...base.budget, searches: 5 } }],
    ['an added field', { fields: { ...base.fields, title: { kind: 'extractive', type: 'string', required: false, desc: '' } } }],
  ];

  for (const [what, override] of edits) {
    it(`changes when ${what} changes`, () => {
      // every one of these left the hash byte-identical before the fix
      expect(templateHash({ ...base, ...override })).not.toBe(templateHash(base));
    });
  }

  it('is stable under key order', () => {
    expect(templateHash({ a: 1, b: { c: 2, d: 3 } })).toBe(templateHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('a strategy edit therefore invalidates the result cache key', () => {
    const one = parseTemplateV2(base);
    const two = parseTemplateV2({ ...base, ...edits[0]![1] });
    expect(resultCacheKey(two, { domain: 'acme.com' }, 'v1')).not.toBe(resultCacheKey(one, { domain: 'acme.com' }, 'v1'));
  });
});

// ---------------------------------------------------------------------------
// 2.6 - optional fields need a budget to be reachable at all
// ---------------------------------------------------------------------------

describe('2.6 optional fields', () => {
  const optionalTemplate = (optional_cycles: number) =>
    parseTemplateV2({
      version: 2,
      name: 'opt',
      threshold: 0.5,
      cycles: 5,
      optional_cycles,
      budget: { searches: 4, visits: 0, wall_ms: 60000, cost_usd: 1 },
      variables: ['company_name', 'domain'],
      fields: {
        description: { kind: 'inferential', type: 'string', required: true },
        news_1: { kind: 'extractive', type: 'string', required: false },
      },
      strategies: [
        { type: 'search', q: '{{company_core}} what does the company do', for: ['description'] },
        { type: 'search', q: '{{company_core}} news', for: ['news_1'] },
      ],
    });

  const world = () => {
    const search = async (q: string) =>
      q.includes('news')
        ? [result('Acme raises', 'https://acme.com/news', 'Acme raises a Series A led by Example Ventures.')]
        : [result('About', 'https://acme.com/about', 'Acme builds payments infrastructure for developers.')];
    const extractor = scriptedExtractor((_i, call) =>
      call.user.includes('acme.com/news')
        ? { fields: { news_1: field('Acme raises a Series A', 'Acme raises a Series A led by Example Ventures.', '[1]') } }
        : { fields: { description: field('Payments infrastructure', 'Acme builds payments infrastructure for developers.', '[1]') } }
    );
    return { search, extractor };
  };

  it('with optional_cycles 0 the news strategy is structurally unreachable', async () => {
    const { search, extractor } = world();
    const res = await runCycle(optionalTemplate(0), INPUTS, baseDeps(extractor, { search }));
    expect(res.status).toBe('completed');
    expect(res.data['news_1']).toBeNull();
    expect(res._meta.strategies_run.map((s) => s.index)).toEqual([0]);
  });

  it('with a dedicated budget it runs, and the row still stops', async () => {
    const { search, extractor } = world();
    const res = await runCycle(optionalTemplate(2), INPUTS, baseDeps(extractor, { search }));
    expect(res.status).toBe('completed');
    expect(res._meta.stop_reason).toBe('complete');
    expect(res.data['news_1']).toBe('Acme raises a Series A');
    expect(res._meta.strategies_run.map((s) => s.index)).toEqual([0, 1]);
  });

  it('the shipped templates take the decision', () => {
    const execs = getTemplateV2('find_executives');
    expect(execs?.fields['linkedin_url']?.required).toBe(true);
    const enrichment = getTemplateV2('company_enrichment');
    expect(enrichment?.optional_cycles).toBe(2);
    expect(getTemplateV2('find_founders')?.optional_cycles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2.9 - profile_scrape bookkeeping and budget
// ---------------------------------------------------------------------------

describe('2.8 / 2.9 profile_scrape', () => {
  const scrapeTemplate = parseTemplateV2({
    version: 2,
    name: 'scrape',
    threshold: 0.7,
    cycles: 6,
    budget: { searches: 4, visits: 3, wall_ms: 40000, cost_usd: 1 },
    variables: ['company_name', 'domain'],
    entity: { name: 'founder', min: 1, max: 2, key: 'full_name' },
    fields: {
      full_name: { kind: 'extractive', type: 'string', required: true },
      linkedin_url: { kind: 'extractive', type: 'linkedin_person_url', required: true },
    },
    strategies: [
      { type: 'search', q: '{{company_core}} founder', for: ['full_name', 'linkedin_url'] },
      { type: 'profile_scrape', max: 2, for: ['full_name', 'linkedin_url'] },
    ],
  });

  const CANDIDATE = 'https://www.linkedin.com/in/ann-rivers';

  function world(scrapeResult: () => Promise<unknown>) {
    const seen: Array<{ urls: string[]; budgetMs?: number }> = [];
    // [1] is a bare LinkedIn hit the snippet rules cannot verify (no role, no
    // company in the headline) - exactly the case profile_scrape exists for.
    // [2] is the company's own site, which locks the name at tier 1.0.
    const search = async () => [
      result('Ann Rivers | LinkedIn', CANDIDATE, 'Ann Rivers. Austin, Texas. 500+ connections.'),
      result('Our team', 'https://acme.com/team', 'Acme was founded by Ann Rivers.'),
    ];
    const extractor = scriptedExtractor((_i, call) =>
      call.user.includes('(profile)')
        ? {
            entities: [
              {
                full_name: field('Ann Rivers', 'Name: Ann Rivers', '[1]'),
                linkedin_url: field(CANDIDATE, `LinkedIn: ${CANDIDATE}`, '[1]'),
              },
            ],
          }
        : { entities: [{ full_name: field('Ann Rivers', 'Acme was founded by Ann Rivers.', '[2]'), linkedin_url: nullField() }] }
    );
    const scrapeProfiles = async (urls: string[], _d: string, _t: string[], opts?: { budgetMs?: number }) => {
      seen.push({ urls, budgetMs: opts?.budgetMs });
      return (await scrapeResult()) as never;
    };
    return { search, extractor, scrapeProfiles, seen };
  }

  it('gets the remaining wall budget', async () => {
    const { search, extractor, scrapeProfiles, seen } = world(async () => []);
    await runCycle(scrapeTemplate, INPUTS, baseDeps(extractor, { search, scrapeProfiles }));
    expect(seen.length).toBe(1);
    // before the fix no budget was passed at all and two 90s Apify timeouts
    // could run past the route timeout
    expect(seen[0]!.budgetMs).toBeGreaterThan(0);
    expect(seen[0]!.budgetMs).toBeLessThanOrEqual(40000);
  });

  it('does not retire a candidate the scrape never returned', async () => {
    const { search, extractor, scrapeProfiles } = world(async () => []);
    const res = await runCycle(scrapeTemplate, INPUTS, baseDeps(extractor, { search, scrapeProfiles }));
    // before the fix one transient Apify 5xx permanently retired the candidate
    expect(res._meta.profile_scrapes ?? []).toEqual([]);
  });

  it('retires it once the scrape comes back', async () => {
    const { search, extractor, scrapeProfiles } = world(async () => [
      {
        ref: '[1]',
        kind: 'profile',
        url: CANDIDATE,
        title: 'Ann Rivers - Co-founder - Acme | LinkedIn',
        text: `Name: Ann Rivers\nLinkedIn: ${CANDIDATE}`,
        domain: 'acme.com',
      },
    ]);
    const res = await runCycle(scrapeTemplate, INPUTS, baseDeps(extractor, { search, scrapeProfiles }));
    expect(res._meta.profile_scrapes).toEqual([CANDIDATE]);
    expect(res.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 3.1 - the claude_code semaphore is a cap
// ---------------------------------------------------------------------------

describe('3.1 semaphore', () => {
  it('hands a released slot to the waiter, not to whoever arrives next', async () => {
    const sem = new Semaphore(1);
    const relA = await sem.acquire();
    expect(sem.inFlight).toBe(1);

    const bP = sem.acquire();
    relA();               // waiter b is resolved; its continuation has not run yet
    const cP = sem.acquire(); // a fresh caller arriving inside that window

    const relB = await bP;
    // before the fix `active` was 0 here, c took the slot and b incremented on
    // top of it, so CLAUDE_CODE_CONCURRENCY drifted upward under load
    expect(sem.inFlight).toBe(1);

    let cTaken = false;
    void cP.then(() => {
      cTaken = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cTaken).toBe(false);

    relB();
    const relC = await cP;
    expect(sem.inFlight).toBe(1);
    relC();
    expect(sem.inFlight).toBe(0);
  });

  it('ignores a double release', async () => {
    const sem = new Semaphore(2);
    const rel = await sem.acquire();
    rel();
    rel();
    expect(sem.inFlight).toBe(0);
  });

  it('never exceeds the cap across a burst with staggered releases', async () => {
    const sem = new Semaphore(3);
    let peak = 0;
    await Promise.all(
      Array.from({ length: 12 }, async (_v, i) => {
        const rel = await sem.acquire();
        peak = Math.max(peak, sem.inFlight);
        await new Promise((r) => setTimeout(r, i % 3));
        rel();
      })
    );
    expect(peak).toBe(3);
    expect(sem.inFlight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3.9 - template name path traversal
// ---------------------------------------------------------------------------

describe('3.9 template names are validated', () => {
  it('accepts the shipped names and refuses traversal', () => {
    expect(isValidTemplateName('find_founders')).toBe(true);
    expect(isValidTemplateName('classify-vertical2')).toBe(true);
    expect(isValidTemplateName('../../../../tmp/x')).toBe(false);
    expect(isValidTemplateName('a/b')).toBe(false);
    expect(isValidTemplateName('a.b')).toBe(false);
    expect(isValidTemplateName('')).toBe(false);
  });

  it('reads outside templates/ return null instead of a file', () => {
    expect(getTemplateAny('../../../../etc/passwd')).toBeNull();
    expect(getTemplateAny('../package')).toBeNull();
    expect(templateExists('../package')).toBe(false);
    expect(getTemplateAny('find_founders')).toBeTruthy();
  });

  it('writes outside templates/ are refused with a 400', () => {
    const yaml = 'version: 2\nname: evil\nfields:\n  a: {type: string}\nstrategies:\n  - {type: search, q: x, for: [a]}\n';
    expect(() => saveTemplate('../../../../tmp/evil', yaml)).toThrow(/Invalid template name/);
    try {
      saveTemplate('../evil', yaml);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });
});
