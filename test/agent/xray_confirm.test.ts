import { describe, expect, it } from 'vitest';
import { runCycle } from '../../src/agent/cycle.js';
import type { EvidenceItem } from '../../src/agent/evidence.js';
import { sameLabel, sameSite, siteDomain } from '../../src/cache/profiles.js';
import { parseTemplateV2 } from '../../src/templates/v2.js';
import { baseDeps, field, foundersTemplate, nullField, result, scriptedExtractor } from './helpers.js';

const INPUTS = { company_name: 'Bodo', domain: 'bodo.ai' };
const REAL = 'https://www.linkedin.com/in/behzad-nasre';
const NAMESAKE = 'https://www.linkedin.com/in/jane-bodo';

function profile(url: string, name: string, title: string, company: string, domain: string): EvidenceItem {
  return {
    ref: '[1]',
    kind: 'profile',
    url,
    title: `${name} - ${title} - ${company} | LinkedIn`,
    text: `Name: ${name}\nTitle: ${title}\nCompany: ${company}\nLinkedIn: ${url}`,
    domain,
  };
}

function xrayTemplate(extra: Record<string, unknown> = {}) {
  return foundersTemplate({
    entity: { name: 'founder', min: 1, max: 3, key: 'full_name', role_pattern: '\\b(co-?founders?|founders?|owner)\\b' },
    strategies: [
      { type: 'xray', q: 'site:linkedin.com/in "{{company_core}}" (founder OR co-founder OR owner)', for: ['full_name', 'linkedin_url'] },
      { type: 'search', q: '{{company_core}} {{domain}} founder OR co-founder', for: ['full_name', 'linkedin_url'] },
    ],
    ...extra,
  });
}

describe('template v2: xray + confirm_linkedin', () => {
  it('parses xray with a default max of 4 and the confirm flag', () => {
    const t = xrayTemplate({ confirm_linkedin: true });
    expect(t.strategies[0]!.type).toBe('xray');
    expect(t.strategies[0]!.max).toBe(4);
    expect(t.confirm_linkedin).toBe(true);
    expect(foundersTemplate().confirm_linkedin).toBe(false);
  });

  it('rejects an xray without q', () => {
    expect(() =>
      parseTemplateV2({
        version: 2, name: 'x', cache_key: ['domain'], fields: { a: { kind: 'extractive', type: 'string', required: true } },
        strategies: [{ type: 'xray', for: ['a'] }],
      })
    ).toThrow(/needs q/);
  });
});

describe('xray strategy', () => {
  it('checks the candidate whose title names the company first, stops at the first verified profile, locks it', async () => {
    const scraped: string[] = [];
    const search = async (q: string) =>
      q.startsWith('site:linkedin.com/in')
        ? [
            result('Jane Bodo - Founder - Sweet Treats | LinkedIn', NAMESAKE, 'Founder of a bakery'),
            result('Behzad Nasre - Co-founder & CEO - Bodo.ai | LinkedIn', REAL, 'Co-founder at Bodo.ai'),
          ]
        : [];
    const scrapeProfiles = async (urls: string[]) => {
      scraped.push(...urls);
      return urls.map((u) => (u === REAL ? profile(REAL, 'Behzad Nasre', 'Co-founder & CEO', 'Bodo.ai', 'bodo.ai') : profile(u, 'Jane Bodo', 'Founder', 'Bodo Bakery', '')));
    };
    const extractor = scriptedExtractor((_i, call) =>
      call.user.includes(REAL)
        ? { entities: [{ full_name: field('Behzad Nasre', 'Name: Behzad Nasre', '[1]'), linkedin_url: field(REAL, `LinkedIn: ${REAL}`, '[1]') }] }
        : { entities: [] }
    );
    const res = await runCycle(xrayTemplate(), INPUTS, baseDeps(extractor, { search, scrapeProfiles }));
    expect(scraped).toEqual([REAL]);
    const founders = res.data['founders'] as Array<Record<string, unknown>>;
    expect(founders.map((f) => f['linkedin_url'])).toEqual([REAL]);
    expect(res._meta.locked['founder[0].linkedin_url']!.verified_by).toBe('profile_cache');
    expect(res._meta.stop_reason).toBe('complete');
  });

  it('a profile with no current job here is never evidence, and the row moves on', async () => {
    const search = async (q: string) =>
      q.startsWith('site:linkedin.com/in') ? [result('Jane Bodo - Founder - Bodo Bakery | LinkedIn', NAMESAKE, 'Founder')] : [];
    const scrapeProfiles = async (urls: string[]) => urls.map((u) => profile(u, 'Jane Bodo', 'Founder', 'Bodo Bakery', ''));
    const calls: string[] = [];
    const extractor = scriptedExtractor((_i, call) => {
      calls.push(call.user);
      return { entities: [] };
    });
    const res = await runCycle(xrayTemplate(), INPUTS, baseDeps(extractor, { search, scrapeProfiles }));
    expect(res.data['founders']).toEqual([]);
    expect(calls.some((u) => u.includes(NAMESAKE))).toBe(false);
  });
});

describe('confirm_linkedin', () => {
  const snippetWorld = (scrapedDomain: string) => {
    const search = async (q: string) =>
      q.includes('founder OR co-founder')
        ? [result('Jay Cody - Co-Founder, Flare AI | LinkedIn', 'https://www.linkedin.com/in/jaycody', 'Jay Cody. Co-Founder, Flare AI')]
        : [];
    const scrapeProfiles = async (urls: string[]) => urls.map((u) => profile(u, 'Jay Cody', 'Co-Founder', 'Flare AI', scrapedDomain));
    const extractor = scriptedExtractor((_i, call) =>
      call.user.includes('jaycody')
        ? {
            entities: [
              {
                full_name: field('Jay Cody', 'Jay Cody. Co-Founder, Flare AI', '[1]'),
                linkedin_url: field('https://www.linkedin.com/in/jaycody', 'https://www.linkedin.com/in/jaycody', '[1]'),
              },
            ],
          }
        : { entities: [] }
    );
    return { search, scrapeProfiles, extractor };
  };
  const tpl = () =>
    foundersTemplate({
      confirm_linkedin: true,
      entity: { name: 'founder', min: 1, max: 3, key: 'full_name', role_pattern: '\\b(co-?founders?|founders?|owner)\\b' },
      strategies: [{ type: 'search', q: '{{company_core}} {{domain}} founder OR co-founder', for: ['full_name', 'linkedin_url'] }],
    });
  const inputs = { company_name: 'Flare AI', domain: 'theflare.ai' };

  it('drops a snippet-verified URL (and the person it alone named) when the profile shows another company', async () => {
    const w = snippetWorld('');
    const res = await runCycle(tpl(), inputs, baseDeps(w.extractor, { search: w.search, scrapeProfiles: w.scrapeProfiles }));
    expect(res.data['founders']).toEqual([]);
    expect(res._meta.candidates['founder?.linkedin_url']?.[0]?.reason).toMatch(/no job at this company/);
  });

  it('upgrades a snippet-verified URL the profile confirms', async () => {
    const w = snippetWorld('theflare.ai');
    const res = await runCycle(tpl(), inputs, baseDeps(w.extractor, { search: w.search, scrapeProfiles: w.scrapeProfiles }));
    const founders = res.data['founders'] as Array<Record<string, unknown>>;
    expect(founders[0]!['linkedin_url']).toBe('https://www.linkedin.com/in/jaycody');
    expect(res._meta.locked['founder[0].linkedin_url']!.verified_by).toBe('profile_confirmed');
  });
});

describe('employer website matching', () => {
  it('normalises a website and compares by host', () => {
    expect(siteDomain('http://www.GroupRaise.com/about')).toBe('groupraise.com');
    expect(sameSite('https://app.bodo.ai', 'bodo.ai')).toBe(true);
    expect(sameSite('https://bodobakery.com', 'bodo.ai')).toBe(false);
    expect(sameSite('', 'bodo.ai')).toBe(false);
    expect(sameLabel('http://www.fieldguide.com', 'fieldguide.io')).toBe(true);
    expect(sameLabel('https://fabrichq.ai/', 'fabric.inc')).toBe(false);
  });
});
