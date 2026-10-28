import { describe, expect, it } from 'vitest';
import { runCycle } from '../../src/agent/cycle.js';
import type { Decider } from '../../src/llm/jev.js';
import { parseTemplateV2 } from '../../src/templates/v2.js';
import { baseDeps, fetchOk, field, result, scriptedExtractor } from './helpers.js';

const PAGE = 'Bilsa makes brake testers and wheel alignment equipment for garages and vehicle inspection centres. '.repeat(5);

function qualifyTemplate() {
  return parseTemplateV2({
    version: 2,
    name: 'q',
    cache_key: ['domain'],
    cycles: 3,
    threshold: 0.5,
    budget: { searches: 1, visits: 3, wall_ms: 60000, cost_usd: 0.01 },
    fields: {
      business_model: { kind: 'inferential', type: 'enum', required: true, enum: ['b2b', 'b2c'], desc: 'who they sell to', criteria: { b2b: 'businesses', b2c: 'consumers' } },
      category: { kind: 'inferential', type: 'enum', required: true, enum: ['manufacturing', 'other'], desc: 'category', criteria: { manufacturing: 'makes things', other: 'anything else' } },
      sells_to: { kind: 'inferential', type: 'string', required: true, desc: 'buyer' },
    },
    strategies: [
      { type: 'jev', from: 'https://{{domain}}', for: ['business_model', 'category'] },
      { type: 'visit_discover', from: 'https://{{domain}}', follow: ['about'], question: 'who buys', for: ['business_model', 'category', 'sells_to'] },
    ],
  });
}

describe('jev strategy', () => {
  it('locks labels Jev is sure of and leaves the unsure one to the extractor', async () => {
    const decide: Decider = async () => ({
      answers: { business_model: { choice: 'b2b', confidence: 0.97 }, category: { choice: 'manufacturing', confidence: 0.6 } },
      cost_usd: 0.0002,
    });
    const extractor = scriptedExtractor((_i, call) => {
      expect(call.user).not.toContain('business_model');
      return { fields: { category: field('manufacturing', 'Bilsa makes brake testers', '[1]'), sells_to: field('garages', 'for garages and vehicle inspection centres', '[1]') } };
    });
    const res = await runCycle(qualifyTemplate(), { company_name: 'Bilsa', domain: 'bybilsa.com' }, baseDeps(extractor, {
      decide,
      fetchPage: async (u) => fetchOk(u, PAGE),
      discoverAndFetch: async (u) => fetchOk(u, PAGE),
    }));
    expect(res.data).toMatchObject({ business_model: 'b2b', category: 'manufacturing', sells_to: 'garages' });
    expect(res._meta.locked['business_model']!.verified_by).toBe('jev');
    expect(res._meta.locked['category']!.verified_by).toBeUndefined();
    expect(res._meta.candidates['category']![0]!.reason).toMatch(/below 0.9/);
  });

  it('is skipped without a decider and never treats "unclear" as an answer', async () => {
    const extractor = scriptedExtractor(() => ({ fields: {} }));
    const deps = baseDeps(extractor, { fetchPage: async (u) => fetchOk(u, PAGE) });
    const res = await runCycle(qualifyTemplate(), { company_name: 'Bilsa', domain: 'bybilsa.com' }, deps);
    expect(res.steps.some((s) => s.strategy_type === 'jev')).toBe(false);

    const unclear: Decider = async () => ({ answers: { business_model: { choice: 'unclear', confidence: 0.99 }, category: { choice: 'other', confidence: 0.95 } }, cost_usd: 0 });
    const res2 = await runCycle(qualifyTemplate(), { company_name: 'Bilsa', domain: 'bybilsa.com' }, { ...deps, decide: unclear });
    expect(res2._meta.locked['business_model']).toBeUndefined();
    expect(res2._meta.locked['category']!.verified_by).toBe('jev');
  });

  it('rejects criteria on a non-enum field and criteria missing an enum value', () => {
    const base = { version: 2, name: 'x', cache_key: ['domain'], strategies: [{ type: 'jev', from: 'https://{{domain}}', for: ['a'] }] };
    expect(() => parseTemplateV2({ ...base, fields: { a: { type: 'string', criteria: { x: 'y' } } } })).toThrow(/only for enum/);
    expect(() => parseTemplateV2({ ...base, fields: { a: { type: 'enum', enum: ['p', 'q'], criteria: { p: 'x' } } } })).toThrow(/missing q/);
  });
});

describe('require_mention', () => {
  it('only pages naming the person AND the company reach the extractor', async () => {
    const tpl = parseTemplateV2({
      version: 2,
      name: 'pod',
      cache_key: ['person_name'],
      cycles: 2,
      require_mention: ['person_name', 'company'],
      entity: { name: 'appearance', min: 1, max: 3, key: 'episode_title' },
      fields: { episode_title: { kind: 'extractive', type: 'string', required: true } },
      strategies: [{ type: 'search', q: '"{{person_name}}" podcast', for: ['episode_title'] }],
    });
    const search = async () => [
      result('Ep 12: Alex Gallego on streaming', 'https://pod.example/12', 'Alex Gallego, founder of Redpanda, joins us.'),
      result('Ep 3: Alex Gallego talks golf', 'https://golf.example/3', 'Alex Gallego, club pro, on his swing.'),
      result('Redpanda launches v24', 'https://news.example/rp', 'Redpanda shipped a release.'),
    ];
    const seen: string[] = [];
    const extractor = scriptedExtractor((_i, call) => {
      seen.push(call.user);
      return { entities: [] };
    });
    await runCycle(tpl, { person_name: 'Alex Gallego', company_name: 'Redpanda', domain: 'redpanda.com' }, baseDeps(extractor, { search }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('pod.example/12');
    expect(seen[0]).not.toContain('golf.example');
    expect(seen[0]).not.toContain('news.example');
  });
});
