import { describe, expect, it } from 'vitest';
import { normalizeName, namesMatch, mergeEntity, type EntityState } from '../../src/agent/entities.js';
import { cleanDisplayName, personNamesMatch } from '../../src/agent/names.js';
import { castValue, castRecord, normalizeLinkedinUrl, parseDate, parseNumeric, type CastFailure } from '../../src/agent/cast.js';
import type { FieldSpecV2 } from '../../src/templates/v2.js';

describe('entity names', () => {
  it('normalises honorifics, suffixes, parentheticals, punctuation', () => {
    expect(normalizeName('Dr. Patrick Collison (CEO)')).toBe('patrick collison');
    expect(normalizeName('John Smith Jr., PhD')).toBe('john smith');
    expect(normalizeName('  Rameez  R.  ')).toBe('rameez r');
  });

  it('matches initials both ways and rejects different people', () => {
    expect(namesMatch('P. Collison', 'Patrick Collison')).toBe(true);
    expect(namesMatch('Rameez R.', 'Rameez Remsudeen')).toBe(true);
    expect(namesMatch('Patrick Collison (CEO)', 'patrick collison')).toBe(true);
    expect(namesMatch('John Collison', 'Patrick Collison')).toBe(false);
    expect(namesMatch('Roger Tracy', 'Roger Tracey')).toBe(false);
    expect(namesMatch('J. S.', 'Jane S.')).toBe(false);
    expect(namesMatch('Madhura', 'Madhura Maskasky')).toBe(false);
  });

  it('merges across cycles, keeps the fuller display name, enforces max', () => {
    const entities: EntityState[] = [];
    const a = mergeEntity(entities, 'P. Collison', 3)!;
    const b = mergeEntity(entities, 'Patrick Collison (CEO)', 3)!;
    expect(a).toBe(b);
    expect(entities.length).toBe(1);
    // The display name must survive personNamesMatch against the same person
    // named plainly, so the title suffix is dropped. This used to assert
    // 'Patrick Collison (CEO)', which silently disabled the name-anchored
    // LinkedIn path for exactly those founders (review 1.10).
    expect(entities[0].display).toBe('Patrick Collison');
    expect(personNamesMatch('Patrick Collison', entities[0].display)).toBe(true);
    mergeEntity(entities, 'John Collison', 3);
    mergeEntity(entities, 'Third Person', 3);
    expect(mergeEntity(entities, 'Fourth Person', 3)).toBeUndefined();
    expect(entities.length).toBe(3);
  });
});

const f = (over: Partial<FieldSpecV2>): FieldSpecV2 => ({ name: 'x', kind: 'extractive', type: 'string', required: false, desc: '', ...over });

describe('cast', () => {
  it('enum is exact-after-normalise only', () => {
    const spec = f({ type: 'enum', enum: ['Data / AI', 'HR Tech', 'Other Tech'] });
    expect(castValue(spec, 'data/ai').value).toBe('Data / AI');
    expect(castValue(spec, 'hr tech').value).toBe('HR Tech');
    expect(castValue(spec, 'Tech')).toEqual({ ok: false, value: null, reason: 'not in enum' });
    expect(castValue(spec, 'AI').ok).toBe(false);
  });

  it('linkedin urls normalise and must be /in/', () => {
    expect(normalizeLinkedinUrl('http://LinkedIn.com/in/Sean-Park/?utm_source=x#top')).toBe('https://www.linkedin.com/in/Sean-Park');
    expect(normalizeLinkedinUrl('linkedin.com/in/sean-park/details/')).toBe('https://www.linkedin.com/in/sean-park');
    expect(normalizeLinkedinUrl('https://www.linkedin.com/company/acme')).toBeNull();
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/')).toBeNull();
    const spec = f({ type: 'linkedin_person_url' });
    expect(castValue(spec, 'https://www.linkedin.com/company/acme').reason).toMatch(/linkedin/);
  });

  it('dates keep their precision', () => {
    expect(parseDate('2026-03-15')).toEqual({ value: '2026-03-15', precision: 'day' });
    expect(parseDate('March 2026')).toEqual({ value: '2026-03', precision: 'month' });
    expect(parseDate('March 15, 2026')).toEqual({ value: '2026-03-15', precision: 'day' });
    expect(parseDate('15 March 2026')).toEqual({ value: '2026-03-15', precision: 'day' });
    expect(parseDate('2026')).toEqual({ value: '2026', precision: 'year' });
    expect(parseDate('sometime')).toBeNull();
  });

  it('numbers parse only with numeric; otherwise stay strings', () => {
    expect(parseNumeric('$1.2M', 'usd')).toEqual({ value: 1_200_000, unit: 'usd' });
    expect(parseNumeric('2,000+', 'count')).toEqual({ value: 2000, unit: 'count', range: { min: 2000 } });
    expect(parseNumeric('10-50', 'count')).toEqual({ value: 10, unit: 'count', range: { min: 10, max: 50 } });
    expect(parseNumeric('$5k - $10k', 'usd')).toEqual({ value: 5000, unit: 'usd', range: { min: 5000, max: 10000 } });
    expect(castValue(f({ type: 'number' }), '$1.2M').value).toBe('$1.2M');
    expect(castValue(f({ type: 'number', numeric: { unit: 'usd' } }), 'lots').ok).toBe(false);
  });

  it('bool, url, list<string>', () => {
    expect(castValue(f({ type: 'bool' }), 'Yes').value).toBe(true);
    expect(castValue(f({ type: 'bool' }), 'maybe').ok).toBe(false);
    expect(castValue(f({ type: 'url' }), 'Stripe.com/About#x').value).toBe('https://stripe.com/About');
    expect(castValue(f({ type: 'url' }), 'nope').ok).toBe(false);
    expect(castValue(f({ type: 'list<string>' }), 'a; b, c').value).toEqual(['a', 'b', 'c']);
    expect(castValue(f({ type: 'list<string>' }), ['x', ' y ']).value).toEqual(['x', 'y']);
  });

  it('castRecord fills nulls and collects cast_failures', () => {
    const fields = {
      vertical: f({ name: 'vertical', type: 'enum', enum: ['SaaS'] }),
      url: f({ name: 'url', type: 'linkedin_person_url' }),
      when: f({ name: 'when', type: 'date' }),
    };
    const failures: CastFailure[] = [];
    const out = castRecord(fields, { vertical: 'Bananas', url: 'https://www.linkedin.com/in/ok' }, failures, 'lead[0].');
    expect(out).toEqual({ vertical: null, url: 'https://www.linkedin.com/in/ok', when: null });
    expect(failures).toEqual([{ field: 'lead[0].vertical', value: 'Bananas', reason: 'not in enum' }]);
  });
});
