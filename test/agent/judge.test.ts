import { describe, expect, it } from 'vitest';
import {
  judgeCandidate,
  textContains,
  containsTokenSequence,
  normalizeText,
  tokenize,
  sourceTier,
  companyTokensFor,
  linkedinVerification,
  type JudgeContext,
} from '../../src/agent/judge.js';
import { searchEvidence, pageEvidence, resolveDate, type EvidenceItem } from '../../src/agent/evidence.js';
import { foundersTemplate, flatTemplate, result } from './helpers.js';

const t = foundersTemplate();

function ctx(overrides: Partial<JudgeContext> = {}): JudgeContext {
  return {
    domain: 'groupraise.com',
    companyTokens: companyTokensFor('Groupraise', 'groupraise.com'),
    threshold: 0.7,
    fields: t.fields,
    ...overrides,
  };
}

const liSnippet = searchEvidence([
  result(
    'Sean James Park - Co-founder - Groupraise | LinkedIn',
    'https://www.linkedin.com/in/sean-james-park-4545b0167',
    'Sean James Park. Co-founder at GroupRaise. Houston, Texas. Helping restaurants host **fundraisers**...'
  ),
  result('GroupRaise Reviews', 'https://www.g2.com/products/groupraise', 'GroupRaise is a fundraising platform for restaurants.'),
]);

describe('normalisation + containment', () => {
  it('strips markdown, folds NFKC, lowercases, collapses whitespace', () => {
    expect(normalizeText('**Sean**   [Park](https://x)  ﬁne …')).toBe('sean park fine');
  });
  /**
   * This used to assert that the gate is token-SET containment and treated that
   * as the requirement. It was the defect (review 1.1), encoded as intent. The
   * gate is now the token SEQUENCE: order and adjacency matter, punctuation,
   * markdown and whitespace do not.
   */
  it('the quote gate matches a contiguous token run, not a bag of words', () => {
    expect(textContains('roger tracey is here', 'Roger Tracy')).toBe(false);
    expect(textContains(liSnippet[0].text, 'Sean James Park')).toBe(true);
    // punctuation, markdown and whitespace differences are still tolerated
    expect(textContains('Madhura Maskasky. Co-founder at Platform9 with Roopak.', 'Madhura Maskasky. Co-founder at Platform9.')).toBe(true);
    expect(textContains('a **bold** claim', 'a bold claim')).toBe(true);
    // but a value assembled out of tokens that are merely present is not
    expect(textContains('John Doe, Founder and CEO. Jane Smith, Head of Marketing.', 'John Smith, Founder and CEO')).toBe(false);
    // order matters
    expect(textContains('Park James Sean', 'Sean James Park')).toBe(false);
    expect(containsTokenSequence(tokenize('james park'), tokenize('sean james park'))).toBe(true);
    expect(containsTokenSequence([], tokenize('anything'))).toBe(false);
  });
  it('relative Serper dates resolve in code', () => {
    const now = new Date('2026-09-22T12:00:00Z');
    expect(resolveDate('3 days ago', now)).toBe('2026-09-19');
    expect(resolveDate('2 weeks ago', now)).toBe('2026-09-08');
    expect(resolveDate('2026-03-01T00:00:00Z', now)).toBe('2026-03-01');
    expect(resolveDate(undefined, now)).toBeUndefined();
  });
});

describe('extractive checks', () => {
  it('passes when value is in the quote and the quote is in the evidence', () => {
    const v = judgeCandidate(
      { field: 'full_name', value: 'Sean James Park', quote: 'Sean James Park. Co-founder at GroupRaise.', source_ref: '[1]', model_confidence: 0.95 },
      liSnippet,
      ctx()
    );
    expect(v.ok).toBe(true);
    expect(v.tier).toBe(0.9);
    expect(v.locked).toBe(true);
    expect(v.model_confidence).toBe(0.95);
  });

  it('fails when the value is not in the quote', () => {
    const v = judgeCandidate({ field: 'full_name', value: 'Roger Tracey', quote: 'Sean James Park. Co-founder at GroupRaise.', source_ref: '[1]' }, liSnippet, ctx());
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/value not contained/);
  });

  it('fails when the quote is not in the evidence', () => {
    const v = judgeCandidate({ field: 'full_name', value: 'Sean James Park', quote: 'Sean James Park founded a chain of bakeries in Paris', source_ref: '[1]' }, liSnippet, ctx());
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/quote not found/);
  });

  it('fails on an invalid source_ref and on empty values', () => {
    expect(judgeCandidate({ field: 'full_name', value: 'Sean James Park', quote: 'Sean James Park', source_ref: '[9]' }, liSnippet, ctx()).reason).toMatch(/source_ref/);
    expect(judgeCandidate({ field: 'full_name', value: '', quote: 'x', source_ref: '[1]' }, liSnippet, ctx()).reason).toMatch(/empty/);
  });

  it('accepts a date value whose year/month appear in the quote', () => {
    const fields = { ...t.fields, when: { name: 'when', kind: 'extractive' as const, type: 'date' as const, required: false, desc: '' } };
    const ev = searchEvidence([result('News', 'https://techcrunch.com/x', 'GroupRaise raised a round', '2026-03-04')]);
    const v = judgeCandidate({ field: 'when', value: '2026-03-04', quote: 'date: 2026-03-04', source_ref: '[1]' }, ev, ctx({ fields }));
    expect(v.ok).toBe(true);
  });
});

describe('inferential checks + confidence formula', () => {
  it('inferential value is free when the quote exists; conf = tier x 0.9', () => {
    const v = judgeCandidate(
      { field: 'country_of_origin', value: 'United States', quote: 'Sean James Park. Co-founder at GroupRaise. Houston, Texas.', source_ref: '[1]' },
      liSnippet,
      ctx()
    );
    expect(v.ok).toBe(true);
    expect(v.conf).toBeCloseTo(0.81, 4);
    expect(v.locked).toBe(true);
  });

  it('own domain = 1.0, linkedin /in/ = 0.9, press = 0.8, other = 0.6, profile = 0.95', () => {
    const mk = (url: string, kind: EvidenceItem['kind'] = 'search'): EvidenceItem => ({ ref: '[1]', kind, url, text: '' });
    expect(sourceTier(mk('https://www.groupraise.com/about'), 'groupraise.com')).toBe(1);
    expect(sourceTier(mk('https://blog.groupraise.com/x'), 'groupraise.com')).toBe(1);
    expect(sourceTier(mk('https://www.linkedin.com/in/sean'), 'groupraise.com')).toBe(0.9);
    expect(sourceTier(mk('https://www.linkedin.com/company/groupraise'), 'groupraise.com')).toBe(0.6);
    expect(sourceTier(mk('https://www.crunchbase.com/organization/groupraise'), 'groupraise.com')).toBe(0.8);
    expect(sourceTier(mk('https://www.g2.com/x'), 'groupraise.com')).toBe(0.6);
    expect(sourceTier(mk('https://www.linkedin.com/in/sean', 'profile'), 'groupraise.com')).toBe(0.95);
  });

  it('a single "other" host does not reach 0.7; a second host corroborates to 0.7 and locks', () => {
    const fields = flatTemplate().fields;
    const one = searchEvidence([result('Review', 'https://www.g2.com/x', 'Founded by Jane Doe in 2019.')]);
    const v1 = judgeCandidate({ field: 'tagline', value: 'Founded by Jane Doe', quote: 'Founded by Jane Doe in 2019.', source_ref: '[1]' }, one, ctx({ fields }));
    expect(v1.conf).toBeCloseTo(0.6, 4);
    expect(v1.locked).toBe(false);

    const two = searchEvidence([
      result('Review', 'https://www.g2.com/x', 'Founded by Jane Doe in 2019.'),
      result('Profile', 'https://www.capterra.com/y', 'The company was founded by Jane Doe.'),
    ]);
    const v2 = judgeCandidate({ field: 'tagline', value: 'Founded by Jane Doe', quote: 'Founded by Jane Doe in 2019.', source_ref: '[1]' }, two, ctx({ fields }));
    expect(v2.corroborated).toBe(true);
    expect(v2.conf).toBeCloseTo(0.7, 4);
    expect(v2.locked).toBe(true);
  });

  it('corroboration also comes from a prior candidate on another host', () => {
    const fields = flatTemplate().fields;
    const one = searchEvidence([result('Review', 'https://www.g2.com/x', 'Founded by Jane Doe in 2019.')]);
    const v = judgeCandidate(
      { field: 'tagline', value: 'Founded by Jane Doe', quote: 'Founded by Jane Doe in 2019.', source_ref: '[1]' },
      one,
      ctx({ fields, priorCandidates: { tagline: [{ value: 'founded by jane doe', host: 'capterra.com' }] } })
    );
    expect(v.corroborated).toBe(true);
    expect(v.locked).toBe(true);
  });

  it('confidence caps at 1.0', () => {
    const page = pageEvidence('https://groupraise.com/about', 'Our founder Sean James Park started GroupRaise in Houston.');
    const ev = [...page, { ...liSnippet[0], ref: '[2]' }];
    const v = judgeCandidate({ field: 'full_name', value: 'Sean James Park', quote: 'Our founder Sean James Park started GroupRaise', source_ref: '[1]' }, ev, ctx());
    expect(v.tier).toBe(1);
    expect(v.corroborated).toBe(true);
    expect(v.conf).toBe(1);
  });
});

describe('LinkedIn acceptance rule', () => {
  const url = 'https://www.linkedin.com/in/sean-james-park-4545b0167';

  it('accepts with company token + role word in the snippet, verified_by snippet', () => {
    const v = judgeCandidate({ field: 'linkedin_url', value: url, quote: `Sean James Park - Co-founder - Groupraise | LinkedIn | ${url}`, source_ref: '[1]' }, liSnippet, ctx());
    expect(v.ok).toBe(true);
    expect(v.verified_by).toBe('snippet');
    expect(v.locked).toBe(true);
  });

  it('rejects a namesake whose snippet lacks the company', () => {
    const ev = searchEvidence([result('Sean Park - Product Manager - Acme | LinkedIn', url, `Sean Park. Product Manager at Acme. ${url}`)]);
    const v = judgeCandidate({ field: 'linkedin_url', value: url, quote: `Sean Park - Product Manager - Acme | LinkedIn | ${url}`, source_ref: '[1]' }, ev, ctx());
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not verified/);
  });

  it('rejects an employee (company but no role word)', () => {
    const ev = searchEvidence([result('Ana Lee - Groupraise | LinkedIn', 'https://www.linkedin.com/in/ana-lee', 'Ana Lee. Groupraise. https://www.linkedin.com/in/ana-lee')]);
    const v = judgeCandidate({ field: 'linkedin_url', value: 'https://www.linkedin.com/in/ana-lee', quote: 'Ana Lee - Groupraise | LinkedIn | https://www.linkedin.com/in/ana-lee', source_ref: '[1]' }, ev, ctx());
    expect(v.ok).toBe(false);
  });

  it('rejects company pages outright', () => {
    const ev = searchEvidence([result('Groupraise | LinkedIn', 'https://www.linkedin.com/company/groupraise', 'Groupraise founder page https://www.linkedin.com/company/groupraise')]);
    const v = judgeCandidate({ field: 'linkedin_url', value: 'https://www.linkedin.com/company/groupraise', quote: 'Groupraise founder page https://www.linkedin.com/company/groupraise', source_ref: '[1]' }, ev, ctx());
    expect(v.reason).toMatch(/personal/);
  });

  it('profile_cache hit with matching domain verifies; other domain does not', () => {
    const profile: EvidenceItem = { ref: '[1]', kind: 'profile', url, text: `Name: Sean James Park\nLinkedIn: ${url}`, domain: 'groupraise.com' };
    expect(linkedinVerification(profile, ctx())).toBe('profile_cache');
    expect(linkedinVerification({ ...profile, domain: 'other.com' }, ctx())).toBeNull();
    const v = judgeCandidate({ field: 'linkedin_url', value: url, quote: `LinkedIn: ${url}`, source_ref: '[1]' }, [profile], ctx());
    expect(v.verified_by).toBe('profile_cache');
    expect(v.tier).toBe(0.95);
  });
});

import { isAmbiguousCompanyName, parseLinkedinTitle, linkedinHeadlineVerified } from '../../src/agent/judge.js';

const ROLE = '\\b(co-?founders?|founders?|founding|co-?owners?|owner)\\b';

describe('role gate + LinkedIn headline parse (precision fixes 2026-09-22)', () => {
  it('parses SERP titles', () => {
    expect(parseLinkedinTitle('Ben Smith - Senior Digital Designer at Unifyr | LinkedIn')).toEqual({ name: 'Ben Smith', headline: 'Senior Digital Designer at Unifyr' });
    expect(parseLinkedinTitle('Saket Saurabh - CEO Nexla | ex-NVIDIA | LinkedIn')?.headline).toMatch(/CEO Nexla/);
    expect(parseLinkedinTitle('Sean James Park - Co-founder - Groupraise | LinkedIn')?.headline).toBe('Co-founder - Groupraise');
  });

  it('headline check rejects an employee whose snippet mentions "founder" elsewhere', () => {
    const item = searchEvidence([
      result('Ben Smith - Senior Digital Designer at Unifyr | LinkedIn', 'https://www.linkedin.com/in/ninjaben', 'Ben Smith. Senior Digital Designer at Unifyr. I work closely with our founder on brand. Unifyr is ...'),
    ])[0]!;
    const c = ctx({ domain: 'unifyr.com', companyTokens: companyTokensFor('Unifyr', 'unifyr.com'), rolePattern: ROLE, entityKey: 'full_name' });
    expect(linkedinHeadlineVerified(item, c)).toBe(false);
    const v = judgeCandidate({ field: 'full_name', value: 'Ben Smith', quote: 'Ben Smith - Senior Digital Designer at Unifyr', source_ref: '[1]' }, [item], c);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/role gate/);
    const u = judgeCandidate({ field: 'linkedin_url', value: 'https://www.linkedin.com/in/ninjaben', quote: 'https://www.linkedin.com/in/ninjaben', source_ref: '[1]' }, [item], c);
    expect(u.ok).toBe(false);
  });

  it('headline check accepts a founder headline at the company', () => {
    const item = liSnippet[0]!;
    const c = ctx({ rolePattern: ROLE, entityKey: 'full_name' });
    expect(linkedinHeadlineVerified(item, c)).toBe(true);
    const v = judgeCandidate({ field: 'full_name', value: 'Sean James Park', quote: 'Sean James Park - Co-founder - Groupraise', source_ref: '[1]' }, liSnippet, c);
    expect(v.ok).toBe(true);
    expect(v.locked).toBe(true);
  });

  it('non-LinkedIn key candidates need the role in the quote', () => {
    const page = pageEvidence('https://groupraise.com/about', 'GroupRaise was started in 2013 by Devin Baptiste, our co-founder and CEO. Ana Lee runs marketing.', 'About')[0]!;
    const c = ctx({ rolePattern: ROLE, entityKey: 'full_name' });
    const ok = judgeCandidate({ field: 'full_name', value: 'Devin Baptiste', quote: 'started in 2013 by Devin Baptiste, our co-founder and CEO', source_ref: page.ref }, [page], c);
    expect(ok.ok).toBe(true);
    expect(ok.tier).toBe(1);
    const bad = judgeCandidate({ field: 'full_name', value: 'Ana Lee', quote: 'Ana Lee runs marketing', source_ref: page.ref }, [page], c);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/role gate/);
  });

  it('ambiguous company names cap third-party tier below threshold until corroborated', () => {
    expect(isAmbiguousCompanyName('Inevitable', 'inevitableos.com')).toBe(true);
    expect(isAmbiguousCompanyName('Brain', 'brain.co')).toBe(true);
    expect(isAmbiguousCompanyName('Groupraise', 'groupraise.com')).toBe(false);
    expect(isAmbiguousCompanyName('Unifyr', 'unifyr.com')).toBe(false);
    expect(isAmbiguousCompanyName('Paperless Parts', 'paperlessparts.com')).toBe(false);
    expect(isAmbiguousCompanyName('Nexla', 'nexla.com')).toBe(false);
    const item = searchEvidence([result('David Thomson - Founder - Inevitable | LinkedIn', 'https://www.linkedin.com/in/davidthomson', 'David Thomson. Founder at Inevitable. London.')])[0]!;
    const c = ctx({ domain: 'inevitableos.com', companyTokens: companyTokensFor('Inevitable', 'inevitableos.com'), rolePattern: ROLE, entityKey: 'full_name', ambiguousName: true });
    const v = judgeCandidate({ field: 'full_name', value: 'David Thomson', quote: 'David Thomson - Founder - Inevitable', source_ref: '[1]' }, [item], c);
    expect(v.ok).toBe(true);
    expect(v.locked).toBe(false);
    expect(v.tier).toBe(0.65);
    // corroborated by the company's own site -> locks
    const c2 = ctx({ ...c, priorCandidates: { full_name: [{ value: 'David Thomson', host: 'inevitableos.com' }] } });
    const v2 = judgeCandidate({ field: 'full_name', value: 'David Thomson', quote: 'David Thomson - Founder - Inevitable', source_ref: '[1]' }, [item], c2);
    expect(v2.locked).toBe(true);
  });
});

import { linkedinNameAnchored, personNamesMatch } from '../../src/agent/judge.js';

describe('name-anchored LinkedIn verification for an established founder', () => {
  const c = ctx({ domain: 'merchwell.com', companyTokens: companyTokensFor('Merchwell', 'merchwell.com'), rolePattern: ROLE, entityKey: 'full_name', entityName: 'Noah Jolly' });

  it('personNamesMatch tolerates initials and middle names', () => {
    expect(personNamesMatch('Noah Jolly', 'Noah A. Jolly')).toBe(true);
    expect(personNamesMatch('Rameez R.', 'Rameez Remsudeen')).toBe(true);
    expect(personNamesMatch('Noah Jolly', 'Noah Smith')).toBe(false);
  });

  it('accepts a matching name with the company anywhere in the snippet', () => {
    const item = searchEvidence([result('Noah Jolly - Merchwell | LinkedIn', 'https://www.linkedin.com/in/noah-jolly-49608612b', 'Noah Jolly. Experience: Merchwell. Austin, Texas.')])[0]!;
    expect(linkedinNameAnchored(item, c)).toBe('name+company');
    const v = judgeCandidate({ field: 'linkedin_url', value: item.url, quote: item.url, source_ref: '[1]' }, [item], c);
    expect(v.ok).toBe(true);
    expect(v.locked).toBe(true);
  });

  it('accepts a matching name whose slug carries the surname when the snippet is bare', () => {
    const item = searchEvidence([result('Hitesh Solanky - Certified Zoho Partner | LinkedIn', 'https://www.linkedin.com/in/hsolanky', 'Hitesh Solanky. Ahmedabad. 500+ connections.')])[0]!;
    const c2 = ctx({ ...c, entityName: 'Hitesh Solanky', companyTokens: companyTokensFor('Softily', 'softily.com'), domain: 'softily.com' });
    expect(linkedinNameAnchored(item, c2)).toBe('name+slug');
  });

  it('rejects a different person even with the company in the snippet', () => {
    const item = searchEvidence([result('Ana Lee - Marketing - Merchwell | LinkedIn', 'https://www.linkedin.com/in/ana-lee', 'Ana Lee. Marketing at Merchwell.')])[0]!;
    expect(linkedinNameAnchored(item, c)).toBeNull();
    const v = judgeCandidate({ field: 'linkedin_url', value: item.url, quote: item.url, source_ref: '[1]' }, [item], c);
    expect(v.ok).toBe(false);
  });

  it('does nothing without an established entity name', () => {
    const item = searchEvidence([result('Noah Jolly - Merchwell | LinkedIn', 'https://www.linkedin.com/in/noah-jolly-49608612b', 'Noah Jolly. Experience: Merchwell.')])[0]!;
    expect(linkedinNameAnchored(item, ctx({ ...c, entityName: undefined }))).toBeNull();
  });
});
