import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { parseTemplateV2, resolveVars, allVarsResolvable, withDerivedInputs, deriveVariables } from '../../src/templates/v2.js';
import { parseAny, getTemplateAny, getTemplate } from '../../src/templates/store.js';
import { foundersTemplate } from './helpers.js';

const TEMPLATES_DIR = path.join(__dirname, '../../templates');

describe('template v2 parsing', () => {
  it('parses every shipped v2 template', () => {
    const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBe(7);
    for (const f of files) {
      const t = parseAny(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8'));
      expect(t.version).toBe(2);
      if (t.version === 2) {
        expect(t.t.strategies.length).toBeGreaterThan(0);
        expect(t.t.template_hash).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it('find_founders takes the golden-set columns, only domain + company_name required', () => {
    const t = getTemplateAny('find_founders');
    expect(t?.version).toBe(2);
    if (t?.version !== 2) return;
    expect(t.t.variables).toEqual(['company_name', 'domain', 'company_linkedin_url', 'industry', 'description', 'founded', 'locality']);
    expect(t.t.required).toEqual(['company_name', 'domain']);
    expect(t.t.entity).toMatchObject({ name: 'founder', min: 1, max: 3, key: 'full_name' });
    expect(new RegExp(t.t.entity!.role_pattern!, 'i').test('Co-founder & CEO')).toBe(true);
    expect(t.t.strategies[0].type).toBe('profile_cache');
  });

  it('v1 copies remain reachable for react mode', () => {
    const v1 = getTemplate('find_founders');
    expect(v1?.user_prompt).toContain('founder');
    expect(v1?.variables).toContain('slug');
  });

  it('applies defaults and derives variables from strategies', () => {
    const t = parseTemplateV2({
      version: 2,
      name: 'x',
      fields: { a: { kind: 'extractive', type: 'string', required: true } },
      strategies: [
        { type: 'search', q: '"{{company_core}}" {{domain}} thing', for: ['a'] },
        { type: 'search', q: '{{sector}} {{a}}', for: ['a'], needs: ['a'] },
      ],
    });
    expect(t.cycles).toBe(5);
    expect(t.budget).toEqual({ searches: 4, visits: 3, wall_ms: 60000, cost_usd: 0.02 });
    expect(t.threshold).toBe(0.7);
    // company_core -> company_name; `a` is a field, not a variable
    expect(t.variables.sort()).toEqual(['company_name', 'domain', 'sector']);
    expect(t.required.sort()).toEqual(['company_name', 'domain', 'sector']);
  });

  it('derives domain from website without listing it as a variable', () => {
    const t = parseTemplateV2({
      version: 2,
      name: 'x',
      variables: ['company_name', 'website'],
      fields: { a: { kind: 'inferential', type: 'string', required: true } },
      strategies: [{ type: 'visit_discover', from: 'https://{{domain}}', follow: ['about'], for: ['a'] }],
    });
    expect(t.variables).toEqual(['company_name', 'website']);
  });

  it('deriveVariables skips entity-scoped tokens', () => {
    const vars = deriveVariables(
      [{ type: 'search', q: '"{{founder.full_name}}" {{company_core}}', for: ['x'] }],
      new Set(['x']),
      'founder'
    );
    expect(vars).toEqual(['company_name']);
  });

  it('rejects broken templates with a reason', () => {
    const base = { version: 2, name: 'x', fields: { a: { kind: 'extractive', type: 'string' } } };
    expect(() => parseTemplateV2({ ...base, strategies: [] })).toThrow(/strategies/);
    expect(() => parseTemplateV2({ ...base, strategies: [{ type: 'search', q: 'q', for: ['nope'] }] })).toThrow(/unknown field nope/);
    expect(() => parseTemplateV2({ ...base, strategies: [{ type: 'search', for: ['a'] }] })).toThrow(/needs q/);
    expect(() => parseTemplateV2({ ...base, strategies: [{ type: 'search', q: 'q', for: ['a'], per_entity: true }] })).toThrow(/per_entity/);
    expect(() => parseTemplateV2({ ...base, fields: { a: { kind: 'x', type: 'string' } }, strategies: [{ type: 'search', q: 'q', for: ['a'] }] })).toThrow(/kind/);
    expect(() => parseTemplateV2({ ...base, fields: { a: { type: 'enum' } }, strategies: [{ type: 'search', q: 'q', for: ['a'] }] })).toThrow(/enum/);
    expect(() => parseTemplateV2({ ...base, strategies: [{ type: 'search', q: 'q', for: ['a'], recency: '2d' }] })).toThrow(/recency/);
  });

  it('POST validation path accepts both versions', () => {
    const v1 = parseAny(yaml.dump({ name: 'old', system_prompt: 's', user_prompt: 'u' }));
    expect(v1.version).toBe(1);
    const v2 = parseAny(yaml.dump({ version: 2, name: 'new', fields: { a: { type: 'string' } }, strategies: [{ type: 'search', q: '{{x}}', for: ['a'] }] }));
    expect(v2.version).toBe(2);
  });
});

describe('{{var}} resolution', () => {
  it('locked values beat inputs, inputs are never overwritten, entity scope resolves', () => {
    const inputs = withDerivedInputs({ company_name: 'Stripe, Inc.', domain: 'https://www.stripe.com/', full_name: 'Input Person' });
    expect(inputs['domain']).toBe('stripe.com');
    expect(inputs['company_core']).toBe('Stripe');
    const ctx = {
      inputs,
      locked: { full_name: 'Locked Person' },
      entity: { name: 'founder', values: { full_name: 'Patrick Collison' } },
    };
    expect(resolveVars('{{full_name}} at {{company_core}}', ctx)).toBe('Locked Person at Stripe');
    expect(resolveVars('{{founder.full_name}} {{domain}}', ctx)).toBe('Patrick Collison stripe.com');
    expect(inputs['full_name']).toBe('Input Person');
  });

  it('quoted phrases get sanitised values', () => {
    const inputs = withDerivedInputs({ company_name: '"ALDIN" group & partners LLC', domain: 'aldin.com' });
    const q = resolveVars('"{{company_name}}" founder {{company_name}}', { inputs });
    expect(q.startsWith('"ALDIN group and partners" founder')).toBe(true);
    expect(q).toContain('"ALDIN" group & partners LLC');
  });

  it('allVarsResolvable is false when an entity value is missing', () => {
    const ctx = { inputs: { domain: 'x.com' }, entity: { name: 'founder', values: {} } };
    expect(allVarsResolvable('"{{founder.full_name}}" {{domain}}', ctx)).toBe(false);
    expect(allVarsResolvable('{{domain}}', ctx)).toBe(true);
  });

  it('helper template builds and hashes deterministically', () => {
    const a = foundersTemplate();
    const b = foundersTemplate();
    expect(a.template_hash).toBe(b.template_hash);
    expect(foundersTemplate({ cycles: 2 }).template_hash).not.toBe(a.template_hash);
  });
});
