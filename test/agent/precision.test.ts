/**
 * Regression tests for REVIEW_v2_engine.md section 1 - the defects that produce
 * wrong data. Every test here fails on the pre-review engine.
 */

import { describe, expect, it } from 'vitest';
import {
  companyTokensFor,
  judgeCandidate,
  linkedinVerification,
  quoteInEvidence,
  sourceTier,
  type JudgeContext,
} from '../../src/agent/judge.js';
import { castValue, normalizeLinkedinUrl } from '../../src/agent/cast.js';
import { companyNameMatches, profileMatchesCompany, escapeLike } from '../../src/cache/profiles.js';
import { pageEvidence, searchEvidence, type EvidenceItem } from '../../src/agent/evidence.js';
import { betterDisplay, cleanDisplayName, personNamesMatch } from '../../src/agent/names.js';
import type { FieldSpecV2 } from '../../src/templates/v2.js';
import { foundersTemplate, result } from './helpers.js';

const t = foundersTemplate();

function ctx(overrides: Partial<JudgeContext> = {}): JudgeContext {
  return {
    domain: 'acme.com',
    companyTokens: companyTokensFor('Acme', 'acme.com'),
    threshold: 0.7,
    fields: t.fields,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1.1 - the quote gate must not let the model splice a value together
// ---------------------------------------------------------------------------

describe('1.1 quote splicing', () => {
  const page = pageEvidence(
    'https://acme.com/team',
    '# Team\nJohn Doe, Founder and CEO.\nJane Smith, Head of Marketing.\nWe are hiring.'
  );

  it('rejects a name that is not on the page but whose tokens all are', () => {
    // This locked at conf 1.0 on the own domain before the fix: every token of
    // "John Smith, Founder and CEO" appears somewhere in the page's token set.
    const v = judgeCandidate(
      { field: 'full_name', value: 'John Smith', quote: 'John Smith, Founder and CEO', source_ref: '[1]', model_confidence: 1 },
      page,
      ctx({ domain: 'acme.com', companyTokens: companyTokensFor('Acme', 'acme.com') })
    );
    expect(v.ok).toBe(false);
    expect(v.locked).toBe(false);
    expect(v.reason).toMatch(/quote not found/);
  });

  it('still accepts the two names that really are on the page', () => {
    const doe = judgeCandidate({ field: 'full_name', value: 'John Doe', quote: 'John Doe, Founder and CEO', source_ref: '[1]' }, page, ctx());
    expect(doe.ok).toBe(true);
    expect(doe.conf).toBe(1);
    const smith = judgeCandidate({ field: 'full_name', value: 'Jane Smith', quote: 'Jane Smith, Head of Marketing', source_ref: '[1]' }, page, ctx());
    expect(smith.ok).toBe(true);
  });

  it('rejects a value spliced out of its own quote', () => {
    const v = judgeCandidate({ field: 'full_name', value: 'John Marketing', quote: 'John Doe, Founder and CEO. Jane Smith, Head of Marketing', source_ref: '[1]' }, page, ctx());
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/value not contained/);
  });

  it('quoteInEvidence tolerates markdown and punctuation but not reordering', () => {
    const item = pageEvidence('https://acme.com/x', 'Our **founder**, Jane Smith, started Acme in 2019.')[0]!;
    expect(quoteInEvidence('Our founder, Jane Smith, started Acme', item)).toBe(true);
    expect(quoteInEvidence('Jane Smith, our founder, started Acme', item)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1.2 / 1.3 - a LinkedIn URL has to belong to the person it is locked onto
// ---------------------------------------------------------------------------

describe('1.2 per-entity LinkedIn fan-out binds the URL to the person', () => {
  const bob = searchEvidence([
    result(
      'Bob Jones - Co-founder & CTO - Acme | LinkedIn',
      'https://www.linkedin.com/in/bob-jones',
      'Bob Jones. Co-founder & CTO at Acme. https://www.linkedin.com/in/bob-jones'
    ),
  ]);
  const cand = {
    field: 'linkedin_url',
    value: 'https://www.linkedin.com/in/bob-jones',
    quote: 'Bob Jones - Co-founder & CTO - Acme | LinkedIn | https://www.linkedin.com/in/bob-jones',
    source_ref: '[1]',
  };

  it("rejects the other co-founder's profile when the entity in scope is Alice", () => {
    // linkedinHeadlineVerified passed first and never checked the name, so the
    // company's OTHER founder locked onto Alice Smith at conf 0.9.
    expect(linkedinVerification(bob[0]!, ctx({ entityName: 'Alice Smith' }), cand.value)).toBeNull();
    const v = judgeCandidate(cand, bob, ctx({ entityName: 'Alice Smith' }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not verified/);
  });

  it('accepts it for the person it is actually about', () => {
    const v = judgeCandidate(cand, bob, ctx({ entityName: 'Bob Jones' }));
    expect(v.ok).toBe(true);
    expect(v.verified_by).toBe('snippet');
    expect(v.locked).toBe(true);
  });

  it("rejects a URL that is not this evidence item's own profile", () => {
    const other = { ...cand, value: 'https://www.linkedin.com/in/someone-else', quote: 'https://www.linkedin.com/in/bob-jones' };
    expect(linkedinVerification(bob[0]!, ctx({ entityName: 'Bob Jones' }), other.value)).toBeNull();
  });

  it('binds a profile_cache row to the person too', () => {
    const profile: EvidenceItem = {
      ref: '[1]',
      kind: 'profile',
      url: 'https://www.linkedin.com/in/bob-jones',
      title: 'Bob Jones - Co-founder - Acme | LinkedIn',
      text: 'Name: Bob Jones\nLinkedIn: https://www.linkedin.com/in/bob-jones',
      domain: 'acme.com',
    };
    expect(linkedinVerification(profile, ctx({ entityName: 'Alice Smith' }))).toBeNull();
    expect(linkedinVerification(profile, ctx({ entityName: 'Bob Jones' }))).toBe('profile_cache');
    expect(linkedinVerification(profile, ctx())).toBe('profile_cache');
  });
});

describe('1.3 a /in/ URL inside a third-party snippet', () => {
  const roundup = searchEvidence([
    result(
      'Acme - Crunchbase Company Profile',
      'https://www.crunchbase.com/organization/acme',
      'Acme. Founders and team: Jane Robertson linkedin.com/in/jane-robertson, Bob Poe linkedin.com/in/bob-poe-intern'
    ),
  ]);
  const quote = 'Acme. Founders and team: Jane Robertson linkedin.com/in/jane-robertson, Bob Poe linkedin.com/in/bob-poe-intern';

  it('no longer locks just because the snippet says the company and "founders"', () => {
    const v = judgeCandidate(
      { field: 'linkedin_url', value: 'https://www.linkedin.com/in/bob-poe-intern', quote, source_ref: '[1]' },
      roundup,
      ctx()
    );
    expect(v.ok).toBe(false);
  });

  it('still refuses when an entity is in scope but the slug is not that person', () => {
    const v = judgeCandidate(
      { field: 'linkedin_url', value: 'https://www.linkedin.com/in/bob-poe-intern', quote, source_ref: '[1]' },
      roundup,
      ctx({ entityName: 'Jane Robertson' })
    );
    expect(v.ok).toBe(false);
  });

  it('accepts only the URL whose slug carries the entity surname', () => {
    const v = judgeCandidate(
      { field: 'linkedin_url', value: 'https://www.linkedin.com/in/jane-robertson', quote, source_ref: '[1]' },
      roundup,
      ctx({ entityName: 'Jane Robertson' })
    );
    expect(v.ok).toBe(true);
    expect(v.verified_by).toBe('snippet');
  });
});

// ---------------------------------------------------------------------------
// 1.4 - lookalike hosts
// ---------------------------------------------------------------------------

describe('1.4 notlinkedin.com is not linkedin.com', () => {
  it('cast refuses to rewrite a lookalike host into a real profile URL', () => {
    expect(normalizeLinkedinUrl('https://notlinkedin.com/in/victim')).toBeNull();
    expect(normalizeLinkedinUrl('https://my-linkedin.com/in/victim')).toBeNull();
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/victim')).toBe('https://www.linkedin.com/in/victim');
    expect(normalizeLinkedinUrl('https://cz.linkedin.com/in/victim')).toBe('https://www.linkedin.com/in/victim');
    const field: FieldSpecV2 = { name: 'linkedin_url', kind: 'extractive', type: 'linkedin_person_url', required: true, desc: '' };
    expect(castValue(field, 'https://my-linkedin.com/in/victim').ok).toBe(false);
  });

  it('the judge does not hand a lookalike host tier 0.9', () => {
    const mk = (url: string): EvidenceItem => ({ ref: '[1]', kind: 'search', url, text: '' });
    expect(sourceTier(mk('https://notlinkedin.com/in/victim'), 'acme.com')).toBe(0.6);
    expect(sourceTier(mk('https://www.linkedin.com/in/real'), 'acme.com')).toBe(0.9);
    expect(sourceTier(mk('https://uk.linkedin.com/in/real'), 'acme.com')).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// 1.5 - corroboration is per subject
// ---------------------------------------------------------------------------

describe('1.5 corroboration is same-subject', () => {
  const fields: Record<string, FieldSpecV2> = {
    title: { name: 'title', kind: 'extractive', type: 'string', required: true, desc: '' },
  };
  const evidence = searchEvidence([
    result('One', 'https://one.com/a', 'Alice Smith, Co-Founder'),
    result('Two', 'https://two.com/b', 'Bob Jones, Co-Founder'),
  ]);
  const cand = { field: 'title', value: 'Co-Founder', quote: 'Alice Smith, Co-Founder', source_ref: '[1]' };

  it('a shared value said about a different person is not corroboration', () => {
    const v = judgeCandidate(cand, evidence, ctx({ fields, subjectName: 'Alice Smith' }));
    expect(v.corroborated).toBe(false);
    expect(v.locked).toBe(false);
  });

  it('the same value about the same person on another host still corroborates', () => {
    const both = searchEvidence([
      result('One', 'https://one.com/a', 'Alice Smith, Co-Founder'),
      result('Two', 'https://two.com/b', 'Alice Smith is Co-Founder of Acme'),
    ]);
    const v = judgeCandidate(cand, both, ctx({ fields, subjectName: 'Alice Smith' }));
    expect(v.corroborated).toBe(true);
    expect(v.locked).toBe(true);
  });

  it('prior candidates are scoped to the subject as well', () => {
    const wrongSubject = judgeCandidate(
      cand,
      [evidence[0]!],
      ctx({ fields, subjectName: 'Alice Smith', priorCandidates: { title: [{ value: 'Co-Founder', host: 'two.com', subject: 'Bob Jones' }] } })
    );
    expect(wrongSubject.corroborated).toBe(false);

    const rightSubject = judgeCandidate(
      cand,
      [evidence[0]!],
      ctx({ fields, subjectName: 'Alice Smith', priorCandidates: { title: [{ value: 'Co-Founder', host: 'two.com', subject: 'Alice Smith' }] } })
    );
    expect(rightSubject.corroborated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1.9 - what gets written into the shared public.linkedin_profiles
// ---------------------------------------------------------------------------

describe('1.9 profile-to-company matching is whole-token and current-only', () => {
  it('a substring of the company name is not a match', () => {
    expect(companyNameMatches('TrustLayer', ['rust'])).toBe(false);
    expect(companyNameMatches('CoreWeave', ['core'])).toBe(false);
    expect(companyNameMatches('TrustLayer', ['trustlayer'])).toBe(true);
    expect(companyNameMatches('Platform9 Systems, Inc.', ['platform9'])).toBe(true);
    expect(companyNameMatches('Acme', ['acme corporation'])).toBe(false);
    expect(companyNameMatches('Acme Corporation', ['acme corporation'])).toBe(true);
  });

  it('a past employer no longer counts as the current company', () => {
    const past = { experience: [{ company: 'TrustLayer', is_current: false, end_date: '2019' }] };
    expect(profileMatchesCompany(past, ['trustlayer'])).toBe(false);
    const current = { experience: [{ company: 'TrustLayer', is_current: true }] };
    expect(profileMatchesCompany(current, ['trustlayer'])).toBe(true);
    const present = { experience: [{ company: 'TrustLayer', end_date: 'Present' }] };
    expect(profileMatchesCompany(present, ['trustlayer'])).toBe(true);
    const headline = { basic_info: { headline: 'Founder at TrustLayer' }, experience: [] };
    expect(profileMatchesCompany(headline, ['trustlayer'])).toBe(true);
    expect(profileMatchesCompany({ experience: [] }, [])).toBe(false);
  });

  it('ILIKE wildcards inside a company slug are escaped', () => {
    expect(escapeLike('acme_co%')).toBe('acme\\_co\\%');
    expect(escapeLike('acme')).toBe('acme');
  });
});

// ---------------------------------------------------------------------------
// 1.10 - one name normaliser
// ---------------------------------------------------------------------------

describe('1.10 display names stay matchable', () => {
  it('strips role suffixes that used to disable the name-anchored path', () => {
    expect(cleanDisplayName('Patrick Collison (CEO)')).toBe('Patrick Collison');
    expect(cleanDisplayName('John Smith, Co-Founder & CEO')).toBe('John Smith');
    expect(cleanDisplayName('Madhura Maskasky | Co-founder')).toBe('Madhura Maskasky');
    expect(cleanDisplayName('Ondrej Plevka - Co-founder & CTO')).toBe('Ondrej Plevka');
    expect(cleanDisplayName('Dr. Jane Roe Jr.')).toBe('Jane Roe');
    expect(cleanDisplayName('Jean-Luc Picard')).toBe('Jean-Luc Picard');
  });

  it('personNamesMatch agrees with the display form both normalisers produce', () => {
    for (const raw of ['Patrick Collison (CEO)', 'John Smith, Co-Founder & CEO', 'Madhura Maskasky | Co-founder']) {
      const display = betterDisplay(raw, raw);
      const plain = cleanDisplayName(raw);
      expect(personNamesMatch(plain, display)).toBe(true);
    }
    expect(betterDisplay('P. Collison', 'Patrick Collison (CEO)')).toBe('Patrick Collison');
    expect(betterDisplay('Patrick Collison', 'P. Collison')).toBe('Patrick Collison');
  });
});
