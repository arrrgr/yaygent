import { describe, expect, it } from 'vitest';
import { runCycle } from '../../src/agent/cycle.js';
import { parseTemplateV2 } from '../../src/templates/v2.js';
import { LRU } from '../../src/cache/lru.js';
import { resultCacheKey, createResultCache } from '../../src/cache/result_cache.js';
import { createPageCache, storablePage } from '../../src/cache/page_cache.js';
import { companySlug, profileToEvidence } from '../../src/cache/profiles.js';
import { baseDeps, field, fetchOk, foundersTemplate, nullField, result, scriptedExtractor } from './helpers.js';

describe('planner ordering with needs', () => {
  const t = parseTemplateV2({
    version: 2,
    name: 'needs_demo',
    threshold: 0.7,
    variables: ['company_name', 'domain'],
    fields: {
      ceo: { kind: 'extractive', type: 'string', required: true },
      ceo_linkedin: { kind: 'extractive', type: 'linkedin_person_url', required: true },
      hq: { kind: 'inferential', type: 'string', required: false },
    },
    strategies: [
      { type: 'search', q: '"{{ceo}}" {{company_core}} linkedin', for: ['ceo_linkedin'], needs: ['ceo'] },
      { type: 'visit', url: 'https://{{domain}}/about', question: 'who is the ceo', for: ['ceo', 'hq'] },
      { type: 'search', q: '{{company_core}} ceo', for: ['ceo'] },
    ],
  });

  it('skips a strategy whose needs are unmet, runs it once the need is locked, and skips strategies for locked fields', async () => {
    const queries: string[] = [];
    const search = async (q: string) => {
      queries.push(q);
      return [result('Jane Doe - CEO - Acme | LinkedIn', 'https://www.linkedin.com/in/jane-doe', 'Jane Doe. CEO at Acme. https://www.linkedin.com/in/jane-doe')];
    };
    const fetchPage = async (url: string) => fetchOk(url, 'About Acme. Our CEO Jane Doe leads the team from Austin, Texas.');
    const extractor = scriptedExtractor((_i, call) =>
      call.user.includes('(page)')
        ? { fields: { ceo: field('Jane Doe', 'Our CEO Jane Doe leads the team', '[1]'), hq: field('Austin, Texas', 'leads the team from Austin, Texas', '[1]') } }
        : { fields: { ceo_linkedin: field('https://www.linkedin.com/in/jane-doe', 'Jane Doe - CEO - Acme | LinkedIn | https://www.linkedin.com/in/jane-doe', '[1]') } }
    );
    const res = await runCycle(t, { company_name: 'Acme', domain: 'acme.com' }, baseDeps(extractor, { search, fetchPage }));
    expect(res.status).toBe('completed');
    // strategy 0 needed ceo (unmet) -> skipped; strategy 1 (visit) locked ceo + hq; on the re-scan
    // strategy 0 is now runnable and locks ceo_linkedin; strategy 2 never runs (ceo already locked)
    expect(res._meta.strategies_run.map((s) => s.index)).toEqual([1, 0]);
    expect(res.data['ceo']).toBe('Jane Doe');
    expect(res.data['hq']).toBe('Austin, Texas');
    expect(res.data['ceo_linkedin']).toBe('https://www.linkedin.com/in/jane-doe');
    expect(queries).toEqual(['"Jane Doe" Acme linkedin']);
    expect(res._meta.budget).toEqual({ searches_used: 1, visits_used: 1 });
  });

  it('runs a needs strategy that comes after the strategy that satisfies it', async () => {
    const reordered = parseTemplateV2({
      version: 2,
      name: 'needs_demo2',
      threshold: 0.7,
      variables: ['company_name', 'domain'],
      fields: {
        ceo: { kind: 'extractive', type: 'string', required: true },
        ceo_linkedin: { kind: 'extractive', type: 'linkedin_person_url', required: true },
      },
      strategies: [
        { type: 'visit', url: 'https://{{domain}}/about', question: 'who is the ceo', for: ['ceo'] },
        { type: 'search', q: '"{{ceo}}" {{company_core}} linkedin', for: ['ceo_linkedin'], needs: ['ceo'] },
      ],
    });
    const queries: string[] = [];
    const search = async (q: string) => {
      queries.push(q);
      return [result('Jane Doe - CEO - Acme | LinkedIn', 'https://www.linkedin.com/in/jane-doe', 'Jane Doe. CEO at Acme. https://www.linkedin.com/in/jane-doe')];
    };
    const fetchPage = async (url: string) => fetchOk(url, 'Our CEO Jane Doe leads the team.');
    const extractor = scriptedExtractor((_i, call) =>
      call.user.includes('(page)')
        ? { fields: { ceo: field('Jane Doe', 'Our CEO Jane Doe leads the team', '[1]') } }
        : { fields: { ceo_linkedin: field('https://www.linkedin.com/in/jane-doe', 'Jane Doe - CEO - Acme | LinkedIn | https://www.linkedin.com/in/jane-doe', '[1]') } }
    );
    const res = await runCycle(reordered, { company_name: 'Acme', domain: 'acme.com' }, baseDeps(extractor, { search, fetchPage }));
    expect(res.status).toBe('completed');
    expect(queries).toEqual(['"Jane Doe" Acme linkedin']);
    expect(res.data['ceo_linkedin']).toBe('https://www.linkedin.com/in/jane-doe');
    expect(res._meta.locked['ceo_linkedin'].verified_by).toBe('snippet');
  });

  it('per_entity strategies are skipped entirely when no entity exists yet', async () => {
    const extractor = scriptedExtractor(() => ({ entities: [{ full_name: nullField(), linkedin_url: nullField() }] }));
    const res = await runCycle(foundersTemplate(), { company_name: 'Acme', domain: 'acme.com' }, baseDeps(extractor, { search: async () => [result('x', 'https://x.com', 'y')] }));
    expect(res._meta.strategies_run.map((s) => s.index)).toEqual([1, 2]);
    expect(res.data).toEqual({ founders: [] });
  });
});

describe('caches', () => {
  it('LRU evicts oldest and expires entries', () => {
    const lru = new LRU<number>(2);
    lru.set('a', 1, 1000, 0);
    lru.set('b', 2, 1000, 0);
    lru.get('a', 1);
    lru.set('c', 3, 1000, 2);
    expect(lru.get('b', 3)).toBeUndefined();
    expect(lru.get('a', 3)).toBe(1);
    expect(lru.get('c', 3)).toBe(3);
    expect(lru.get('c', 2000)).toBeUndefined();
  });

  it('result cache key covers name, template hash, code version and only the cache_key inputs', () => {
    const t = foundersTemplate();
    const k1 = resultCacheKey(t, { domain: 'Acme.com ', company_name: 'Acme' }, 'v1');
    expect(resultCacheKey(t, { domain: 'acme.com', company_name: 'Different Name' }, 'v1')).toBe(k1);
    expect(resultCacheKey(t, { domain: 'acme.com' }, 'v2')).not.toBe(k1);
    expect(resultCacheKey(foundersTemplate({ threshold: 0.8 }), { domain: 'acme.com' }, 'v1')).not.toBe(k1);
    expect(resultCacheKey({ ...t, name: 'other' }, { domain: 'acme.com' }, 'v1')).not.toBe(k1);
  });

  it('in-process result cache works without a database', async () => {
    const cache = createResultCache();
    const t = foundersTemplate();
    const key = cache.key(t, { domain: 'acme.com' }, 'v');
    expect(await cache.get(key)).toBeNull();
    cache.set({ cache_key: key, template: t.name, template_hash: t.template_hash, code_version: 'v', complete: true, data: { a: 1 }, meta: {} });
    expect((await cache.get(key))?.data).toEqual({ a: 1 });
  });

  it('page cache refuses challenge pages, errors and thin bodies', () => {
    const base = { url_norm: 'https://a.com', url_final: 'https://a.com', tier: 'direct', fetched_at: 'now' };
    expect(storablePage({ ...base, status: 200, bytes: 10, markdown: 'x'.repeat(600) })).toBe(true);
    expect(storablePage({ ...base, status: 403, bytes: 10, markdown: 'x'.repeat(600) })).toBe(false);
    expect(storablePage({ ...base, status: 200, bytes: 10, markdown: 'short' })).toBe(false);
    const pc = createPageCache();
    pc.set({ ...base, status: 200, bytes: 10, markdown: 'x'.repeat(600) });
    pc.set({ ...base, url_norm: 'https://b.com', status: 200, bytes: 10, markdown: 'tiny' });
    return Promise.all([pc.get('https://a.com'), pc.get('https://b.com')]).then(([a, b]) => {
      expect(a?.markdown.length).toBe(600);
      expect(b).toBeNull();
      expect(pc.hits()).toBe(1);
    });
  });

  it('profiles: slug parsing and evidence text', () => {
    expect(companySlug('https://www.linkedin.com/company/groupraise.com')).toBe('groupraise.com');
    expect(companySlug('https://www.linkedin.com/company/Phyrsts/')).toBe('phyrsts');
    expect(companySlug(undefined)).toBeNull();
    const ev = profileToEvidence(
      {
        linkedin_url: 'https://www.linkedin.com/in/petithomme',
        full_name: 'Y. N. Petithomme',
        headline: 'Founder CEO at Phyrst',
        current_title: 'Founder CEO',
        current_company: 'Phyrst',
        current_company_domain: 'phyrsts.com',
        location: 'Boca Raton',
        experience: [{ title: 'Founder CEO', companyName: 'Phyrst', startDate: '1995' }],
        education: [{ schoolName: 'FAU', degree: 'BSc', years: '1990-1994' }],
      },
      '[1]',
      'phyrsts.com'
    );
    expect(ev.kind).toBe('profile');
    expect(ev.domain).toBe('phyrsts.com');
    expect(ev.text).toContain('Education: FAU - BSc (1990-1994)');
    expect(ev.text).toContain('Experience: Founder CEO at Phyrst (1995)');
    expect(ev.title).toBe('Y. N. Petithomme - Founder CEO - Phyrst | LinkedIn');
  });
});

import { candidateLinkedinUrls } from '../../src/agent/cycle.js';

describe('profile_scrape candidate selection', () => {
  it('prefers rejected linkedin_url candidates, then seen SERP urls, skipping locked and scraped', () => {
    const s = {
      entities: [{ locked: { linkedin_url: { value: 'https://www.linkedin.com/in/locked-one' } } }],
      meta: {
        profile_scrapes: ['https://www.linkedin.com/in/already'],
        candidates: {
          'founder?.linkedin_url': [{ value: 'https://www.linkedin.com/in/cand-a' }, { value: 'https://www.linkedin.com/in/already' }],
          'founder?.full_name': [{ value: 'Someone' }],
        },
      },
      seenLinkedin: ['https://www.linkedin.com/in/locked-one', 'https://www.linkedin.com/in/seen-b/', 'https://www.linkedin.com/in/cand-a?trk=x'],
    } as never;
    expect(candidateLinkedinUrls(s, 3)).toEqual(['https://www.linkedin.com/in/cand-a', 'https://www.linkedin.com/in/seen-b/']);
    expect(candidateLinkedinUrls(s, 1)).toEqual(['https://www.linkedin.com/in/cand-a']);
  });
});

import { sslOptionFor } from '../../src/cache/db.js';

describe('database TLS mode (Supavisor pooler presents a self-signed chain)', () => {
  it('encrypts without chain verification for sslmode=require', () => {
    expect(sslOptionFor('postgresql://u:p@aws-1-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require'))
      .toEqual({ rejectUnauthorized: false });
  });

  it('keeps verification on when the caller asks for it', () => {
    expect(sslOptionFor('postgresql://h/db?sslmode=verify-full')).toEqual({ rejectUnauthorized: true });
  });

  it('leaves ssl unset when disabled or unspecified', () => {
    expect(sslOptionFor('postgresql://h/db?sslmode=disable')).toBeUndefined();
    expect(sslOptionFor('postgresql://h/db')).toBeUndefined();
  });
});

import { stripSslMode } from '../../src/cache/db.js';

describe('stripSslMode', () => {
  it('removes sslmode so the explicit ssl option is authoritative', () => {
    expect(stripSslMode('postgresql://u:p@h:5432/db?sslmode=require')).toBe('postgresql://u:p@h:5432/db');
    expect(stripSslMode('postgresql://u:p@h:5432/db?sslmode=require&application_name=x'))
      .toBe('postgresql://u:p@h:5432/db?application_name=x');
    expect(stripSslMode('postgresql://u:p@h:5432/db?a=1&sslmode=require')).toBe('postgresql://u:p@h:5432/db?a=1');
    expect(stripSslMode('postgresql://u:p@h:5432/db')).toBe('postgresql://u:p@h:5432/db');
  });
});
