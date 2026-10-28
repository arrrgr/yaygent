import { describe, expect, it } from 'vitest';
import { runCycle } from '../../src/agent/cycle.js';
import type { ResultCache, CachedResult } from '../../src/cache/result_cache.js';
import { resultCacheKey } from '../../src/cache/result_cache.js';
import { baseDeps, field, fetchOk, flatTemplate, foundersTemplate, nullField, result, scriptedExtractor } from './helpers.js';

const INPUTS = { company_name: 'Platform9 Systems, Inc.', domain: 'platform9.com', locality: 'San Jose' };

const MADHURA = 'https://www.linkedin.com/in/madhuramaskasky';
const ROOPAK = 'https://www.linkedin.com/in/roopak-parikh';

/**
 * Scripted world: strategy 1 finds both names and Madhura's LI; strategy 2 (entity-level,
 * runs because Roopak still lacks linkedin_url) re-names both without a URL; the per-entity
 * LI search (strategy 4) finds Roopak's URL. Three strategies, two founders.
 */
function foundersWorld() {
  const search = async (q: string) => {
    if (q.includes('site:linkedin.com/in')) {
      return [
        result('Madhura Maskasky - Co-founder, CPO - Platform9 | LinkedIn', MADHURA, `Madhura Maskasky. Co-founder at Platform9 with Roopak Parikh. ${MADHURA}`),
        result('Platform9 | LinkedIn', 'https://www.linkedin.com/company/platform9systems', 'Platform9 simplifies private clouds.'),
      ];
    }
    if (q.includes('founder OR co-founder')) {
      return [
        result('Platform9 raises Series D', 'https://techcrunch.com/platform9', 'Platform9, founded by Madhura Maskasky and Roopak Parikh, raised...'),
        result('About Platform9', 'https://platform9.com/about', 'Founded by Roopak Parikh and Madhura Maskasky, VMware veterans.'),
      ];
    }
    if (q.includes('Roopak Parikh') && q.includes('linkedin')) {
      return [result('Roopak Parikh - Co-founder & CTO - Platform9 | LinkedIn', ROOPAK, `Roopak Parikh. Co-founder & CTO at Platform9. ${ROOPAK}`)];
    }
    return [];
  };

  const extractor = scriptedExtractor((_i, call) => {
    const u = call.user;
    if (u.includes(MADHURA)) {
      return {
        entities: [
          {
            full_name: field('Madhura Maskasky', 'Madhura Maskasky. Co-founder at Platform9.', '[1]'),
            linkedin_url: field(MADHURA, `Madhura Maskasky - Co-founder, CPO - Platform9 | LinkedIn | ${MADHURA}`, '[1]'),
          },
          { full_name: field('Roopak Parikh', 'Co-founder at Platform9 with Roopak Parikh', '[1]'), linkedin_url: nullField() },
        ],
      };
    }
    if (u.includes('techcrunch.com/platform9')) {
      return {
        entities: [
          { full_name: field('Madhura Maskasky', 'founded by Madhura Maskasky and Roopak Parikh', '[1]'), linkedin_url: nullField() },
          { full_name: field('Roopak Parikh', 'Founded by Roopak Parikh and Madhura Maskasky', '[2]'), linkedin_url: nullField() },
        ],
      };
    }
    if (u.includes(ROOPAK)) {
      return { fields: { linkedin_url: field(ROOPAK, `Roopak Parikh - Co-founder & CTO - Platform9 | LinkedIn | ${ROOPAK}`, '[1]') } };
    }
    return { fields: {}, entities: [] };
  });

  return { search, extractor };
}

describe('cycle end-to-end (founders)', () => {
  it('finds 2 founders across 3 strategies, locks per entity, stops complete', async () => {
    const { search, extractor } = foundersWorld();
    const res = await runCycle(foundersTemplate(), INPUTS, baseDeps(extractor, { search }));

    expect(res.status).toBe('completed');
    expect(res._meta.stop_reason).toBe('complete');
    const founders = res.data['founders'] as Array<Record<string, unknown>>;
    expect(founders.map((f) => f['full_name'])).toEqual(['Madhura Maskasky', 'Roopak Parikh']);
    expect(founders[0]['linkedin_url']).toBe(MADHURA);
    expect(founders[1]['linkedin_url']).toBe(ROOPAK);
    expect(founders[0]['country_of_origin']).toBeNull();

    // profile_cache had no dep -> skipped; strategies 1, 2 ran at entity level, 4 ran per entity for Roopak only
    expect(res._meta.strategies_run.map((s) => [s.index, s.entity ?? null])).toEqual([
      [1, null],
      [2, null],
      [4, 'Roopak Parikh'],
    ]);
    expect(res.turns).toBe(3);
    expect(res._meta.budget).toEqual({ searches_used: 3, visits_used: 0 });
    expect(res._meta.locked['founder[0].linkedin_url'].verified_by).toBe('snippet');
    expect(res._meta.locked['founder[1].linkedin_url'].verified_by).toBe('snippet');
    expect(res._meta.locked['founder[0].full_name'].source_url).toBe(MADHURA);
    expect(res._meta.cost_usd).toBeCloseTo(0.003, 6);
    expect(res._meta.tokens).toEqual({ in: 300, out: 60 });
    expect(res._meta.cost_basis).toBe('api');
    expect(res._meta.locked['founder[1].full_name'].cycle).toBe(0);
    expect(res._meta.locked['founder[1].full_name'].conf).toBe(0.9);
    // the extractor was only ever asked for the missing fields
    const lastCall = extractor.calls[extractor.calls.length - 1];
    expect(lastCall.user).toContain('This call is about one founder: Roopak Parikh');
    expect(Object.keys((lastCall.schema['properties'] as Record<string, unknown>))).toEqual(['fields']);
    expect(lastCall.user).not.toContain('- full_name');
    expect(res.steps.every((s) => typeof s.cycle === 'number')).toBe(true);
  });

  it('a locked field is never re-extracted or overwritten by later evidence', async () => {
    const { search, extractor } = foundersWorld();
    const res = await runCycle(foundersTemplate(), INPUTS, baseDeps(extractor, { search }));
    // strategy 2 re-emitted Madhura with a techcrunch quote; the lock from strategy 1 must survive
    const lock = res._meta.locked['founder[0].full_name'];
    expect(lock.source_url).toBe(MADHURA);
    expect(lock.cycle).toBe(0);
    expect(res._meta.locked['founder[0].linkedin_url'].cycle).toBe(0);
    // no per-entity linkedin search ran for Madhura because her URL was already locked
    expect(res._meta.strategies_run.some((s) => s.index === 4 && s.entity === 'Madhura Maskasky')).toBe(false);
  });

  it('per_entity strategies fan out to every entity up to entity.max and need the key locked', async () => {
    const extractor = scriptedExtractor((_i, call) => {
      if (call.user.includes('techcrunch')) {
        return {
          entities: ['A One', 'B Two', 'C Three'].map((n, i) => ({
            full_name: field(n, `founders ${n}`, i === 0 ? '[1]' : '[2]'),
            linkedin_url: nullField(),
          })),
        };
      }
      return { fields: { linkedin_url: nullField() } };
    });
    const search = async (q: string) => {
      if (q.includes('founder OR co-founder')) {
        return [
          result('x', 'https://techcrunch.com/a', 'founders A One'),
          result('y', 'https://platform9.com/team', 'founders B Two, founders C Three'),
        ];
      }
      if (q.includes('site:linkedin')) return [];
      return [result('z', 'https://example.com/z', 'nothing here')];
    };
    const t = foundersTemplate({ budget: { searches: 10, visits: 3, wall_ms: 60000, cost_usd: 1 }, cycles: 10 });
    const res = await runCycle(t, INPUTS, baseDeps(extractor, { search }));
    const fanouts = res._meta.strategies_run.filter((s) => s.index === 4).map((s) => s.entity);
    // The cap used to be a module constant of 2 while entity.max was 3, so the
    // third founder was never searched for AND never checked for completeness
    // (review 1.7). Both are entity.max now.
    expect(fanouts).toEqual(['A One', 'B Two', 'C Three']);
    expect((res.data['founders'] as unknown[]).length).toBe(3);
    expect(res.status).toBe('partial');
  });

  it('stops on the search budget and reports it', async () => {
    const extractor = scriptedExtractor(() => ({ entities: [] }));
    const search = async () => [result('x', 'https://example.com', 'nothing')];
    const t = foundersTemplate({ budget: { searches: 1, visits: 0, wall_ms: 60000, cost_usd: 1 } });
    const res = await runCycle(t, INPUTS, baseDeps(extractor, { search }));
    expect(res.status).toBe('partial');
    expect(res._meta.budget.searches_used).toBe(1);
    // 'budget' and not 'strategies_exhausted': a template that ran out of money
    // is not a template that ran out of ideas (review 2.12).
    expect(res._meta.stop_reason).toBe('budget');
    expect(extractor.calls.length).toBe(1);
    expect(res.data).toEqual({ founders: [] });
  });

  it('stops on the cost cap before the next scout', async () => {
    const extractor = scriptedExtractor(() => ({ entities: [] }), 0.015);
    const search = async () => [result('x', 'https://example.com', 'nothing')];
    const t = foundersTemplate({ budget: { searches: 10, visits: 3, wall_ms: 60000, cost_usd: 0.02 }, cycles: 10 });
    const res = await runCycle(t, INPUTS, baseDeps(extractor, { search }));
    expect(res._meta.stop_reason).toBe('cost');
    expect(extractor.calls.length).toBe(2);
    expect(res.cost_usd).toBeCloseTo(0.03, 6);
  });

  it('does not apply the cost cap to subscription (claude_code) accounting', async () => {
    const extractor = { ...scriptedExtractor(() => ({ entities: [] }), 0.03), provider: 'claude_code' as const };
    const search = async () => [result('x', 'https://example.com', 'nothing')];
    const t = foundersTemplate({ budget: { searches: 10, visits: 3, wall_ms: 60000, cost_usd: 0.02 }, cycles: 10 });
    const res = await runCycle(t, INPUTS, baseDeps(extractor, { search }));
    expect(res._meta.cost_basis).toBe('subscription');
    expect(res._meta.stop_reason).not.toBe('cost');
    expect(res.cost_usd).toBeGreaterThan(0.02);
  });

  it('stops on cycles (max_turns) and on the wall clock', async () => {
    const extractor = scriptedExtractor(() => ({ entities: [] }));
    const search = async () => [result('x', 'https://example.com', 'nothing')];
    const capped = await runCycle(foundersTemplate(), INPUTS, baseDeps(extractor, { search }), { cycles: 1 });
    expect(capped._meta.stop_reason).toBe('cycles');
    expect(capped.turns).toBe(1);

    let clock = 0;
    const slow = baseDeps(extractor, { search: async () => { clock += 70_000; return []; }, now: () => clock });
    const walled = await runCycle(foundersTemplate(), INPUTS, slow);
    expect(walled._meta.stop_reason).toBe('wall');
  });

  it('short-circuits on a result cache hit and writes behind on a miss', async () => {
    const store = new Map<string, CachedResult>();
    const cache: ResultCache = {
      key: resultCacheKey,
      get: async (k) => store.get(k) ?? null,
      set: (e) => store.set(e.cache_key, { ...e, created_at: 'now' }),
    };
    const { search, extractor } = foundersWorld();
    const deps = baseDeps(extractor, { search, resultCache: cache });
    const first = await runCycle(foundersTemplate(), INPUTS, deps);
    expect(first._meta.cache.result_hit).toBe(false);
    expect(store.size).toBe(1);
    const [entry] = [...store.values()];
    expect(entry.complete).toBe(true);

    const callsBefore = extractor.calls.length;
    const second = await runCycle(foundersTemplate(), { ...INPUTS, company_name: 'platform9' }, deps);
    expect(second._meta.cache.result_hit).toBe(true);
    expect(second.data).toEqual(first.data);
    expect(second.steps).toEqual([]);
    expect(second.cost_usd).toBe(0);
    expect(extractor.calls.length).toBe(callsBefore);

    // a template edit changes the key
    const edited = await runCycle(foundersTemplate({ cycles: 2 }), INPUTS, deps);
    expect(edited._meta.cache.result_hit).toBe(false);
  });

  it('uses profile_cache evidence first without spending budget', async () => {
    const profiles = async () => [
      { ref: '[1]', kind: 'profile' as const, url: MADHURA, title: 'Madhura Maskasky - Co-founder - Platform9 | LinkedIn', text: `Name: Madhura Maskasky\nTitle: Co-founder\nLinkedIn: ${MADHURA}\nEducation: IIT Bombay (2001)`, domain: 'platform9.com' },
    ];
    const extractor = scriptedExtractor((_i, call) => {
      if (call.user.includes('(profile)')) {
        return {
          entities: [
            {
              full_name: field('Madhura Maskasky', 'Name: Madhura Maskasky', '[1]'),
              linkedin_url: field(MADHURA, `LinkedIn: ${MADHURA}`, '[1]'),
              country_of_origin: field('India', 'Education: IIT Bombay (2001)', '[1]'),
            },
          ],
        };
      }
      return { entities: [] };
    });
    const res = await runCycle(foundersTemplate(), INPUTS, baseDeps(extractor, { profiles }));
    expect(res.status).toBe('completed');
    expect(res.turns).toBe(0);
    expect(res._meta.budget.searches_used).toBe(0);
    expect(res._meta.locked['founder[0].linkedin_url'].verified_by).toBe('profile_cache');
    expect(res._meta.locked['founder[0].linkedin_url'].conf).toBe(0.95);
    expect((res.data['founders'] as Array<Record<string, unknown>>)[0]['country_of_origin']).toBe('India');
  });
});

describe('cycle end-to-end (flat template)', () => {
  it('extracts only missing fields, visits when search is thin, casts enums, records cast_failures', async () => {
    const search = async () => [result('Acme - Payments for the internet', 'https://www.g2.com/acme', 'Acme is a SaaS payments platform for developers.')];
    const discoverAndFetch = async (url: string) => ({
      ...fetchOk(`${url}/about`, '# About Acme\nPayments infrastructure for the internet. Developers integrate our API.'),
      discovered_url: `${url}/about`,
    });
    const extractor = scriptedExtractor((i) =>
      i === 0
        ? { fields: { vertical: field('Banana', 'Acme is a SaaS payments platform', '[1]'), tagline: nullField() } }
        : { fields: { tagline: field('Payments infrastructure for the internet', 'Payments infrastructure for the internet.', '[1]') } }
    );
    const t = flatTemplate({
      fields: {
        vertical: { kind: 'inferential', type: 'enum', required: true, enum: ['SaaS', 'FinTech', 'Data / AI'] },
        tagline: { kind: 'extractive', type: 'string', required: true },
      },
    });
    const res = await runCycle(t, { company_name: 'Acme Inc', website: 'https://acme.com' }, baseDeps(extractor, { search, discoverAndFetch }));

    // call 0: a snippet on g2 (0.6 x 0.9 = 0.54 >= 0.5) locks the (bad) enum value; cast fails -> null + cast_failures
    expect(res._meta.locked['vertical'].conf).toBeCloseTo(0.54, 4);
    expect(res.data['vertical']).toBeNull();
    expect(res._meta.cast_failures).toEqual([{ field: 'vertical', value: 'Banana', reason: 'not in enum' }]);
    // call 1 only asked for tagline
    expect(extractor.calls[1].user).not.toContain('- vertical');
    expect(res.data['tagline']).toBe('Payments infrastructure for the internet');
    expect(res._meta.locked['tagline'].conf).toBe(1);
    expect(res._meta.tier_reached).toEqual(['direct']);
    expect(res._meta.bytes_by_tier['direct']).toBeGreaterThan(0);
    expect(res.steps[1].url).toBe('https://acme.com/about');
  });

  it('records error steps for failed scouts and extractor errors, and keeps going', async () => {
    const search = async (q: string) => {
      if (q.includes('what does')) throw new Error('serper down');
      return [];
    };
    const extractor = scriptedExtractor(() => {
      throw new Error('llm down');
    });
    const discoverAndFetch = async (url: string) => ({ ...fetchOk(url, 'x'.repeat(50)), discovered_url: undefined });
    const res = await runCycle(flatTemplate(), { company_name: 'Acme', website: 'acme.com' }, baseDeps(extractor, { search, discoverAndFetch }));
    expect(res.status).toBe('partial');
    expect(res.steps.map((s) => s.type)).toEqual(['error', 'error']);
    expect(res.steps[0].reasoning).toMatch(/serper down/);
    expect(res.steps[1].reasoning).toMatch(/llm down/);
  });
});
