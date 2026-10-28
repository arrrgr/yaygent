/**
 * Extract: JSON schema for the missing fields, the system rules, the user
 * message (fields + evidence), one extractor call, candidates out.
 */

import type { Extractor, ExtractResult, JsonSchema } from '../llm/types.js';
import type { EntitySpecV2, FieldSpecV2 } from '../templates/v2.js';
import { formatEvidence, type EvidenceItem } from './evidence.js';
import type { Candidate } from './judge.js';

export interface EntityCandidate {
  name: string;
  fields: Candidate[];
}

export interface ExtractionOutcome {
  /** non-entity templates and per-entity fan-outs */
  fields: Candidate[];
  /** entity templates: one group per entity the model emitted */
  entities: EntityCandidate[];
  usage: ExtractResult['usage'];
  raw: string;
}

function valueSchema(field: FieldSpecV2): Record<string, unknown> {
  switch (field.type) {
    case 'enum':
      return { type: ['string', 'null'], enum: [...(field.enum ?? []), null] };
    case 'bool':
      return { type: ['boolean', 'null'] };
    case 'list<string>':
      return { type: ['array', 'null'], items: { type: 'string' } };
    default:
      // number stays a string here: "$1.2M" / "2,000+" are parsed by cast
      return { type: ['string', 'null'] };
  }
}

function fieldSchema(field: FieldSpecV2): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      value: valueSchema(field),
      quote: { type: ['string', 'null'], description: 'verbatim text from the cited evidence item that supports the value' },
      source_ref: { type: ['string', 'null'], description: 'the evidence ref, e.g. [2]' },
      confidence: { type: ['number', 'null'] },
    },
    required: ['value', 'quote', 'source_ref', 'confidence'],
    additionalProperties: false,
  };
}

function fieldsObjectSchema(fields: FieldSpecV2[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) properties[f.name] = fieldSchema(f);
  return { type: 'object', properties, required: fields.map((f) => f.name), additionalProperties: false };
}

/** {fields: {...}} for flat templates, {entities: [{...}]} for entity templates. */
export function buildSchema(fields: FieldSpecV2[], entity?: EntitySpecV2): JsonSchema {
  if (entity) {
    return {
      type: 'object',
      properties: {
        entities: { type: 'array', maxItems: entity.max, items: fieldsObjectSchema(fields) },
      },
      required: ['entities'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: { fields: fieldsObjectSchema(fields) },
    required: ['fields'],
    additionalProperties: false,
  };
}

export function buildSystemPrompt(entity?: EntitySpecV2): string {
  const lines = [
    'You extract structured fields from the evidence items provided. You have no other knowledge.',
    'Rules:',
    '1. Every value must come from the evidence. If the evidence does not state it, return null for value, quote and source_ref. Never guess, never use outside knowledge.',
    '2. quote is copied verbatim from the cited evidence item (title, url, date line or text). Do not paraphrase or shorten words. For url and date fields, the quote must include the url or the date text itself.',
    '3. source_ref must be exactly one of the listed refs, e.g. [3]. It is the item the quote was copied from.',
    '4. Extractive fields (names, titles, urls, dates, numbers) are copied exactly as written; inferential fields (descriptions, categories, countries) are your reading of the quote.',
    '5. confidence is your own 0-1 estimate. It is recorded, not trusted.',
  ];
  if (entity) {
    lines.push(
      `6. Emit one entry per distinct ${entity.name} the evidence names (at most ${entity.max}). Each entry has the same fields. Skip people whose role in the evidence is not a ${entity.name}.`
    );
  }
  return lines.join('\n');
}

export interface UserPromptOptions {
  fields: FieldSpecV2[];
  evidence: EvidenceItem[];
  entity?: EntitySpecV2;
  /** per-entity fan-out: the entity this call is about */
  entityName?: string;
  /** what the row is about, for disambiguation */
  subject?: string;
}

export function buildUserPrompt(opts: UserPromptOptions): string {
  const fieldLines = opts.fields.map((f) => {
    const bits = [`- ${f.name} (${f.kind}, ${f.type}${f.required ? ', required' : ''})`];
    if (f.desc) bits.push(`: ${f.desc}`);
    if (f.enum) bits.push(` Allowed values: ${f.enum.join(' | ')}`);
    return bits.join('');
  });
  const head: string[] = [];
  if (opts.subject) head.push(`Subject: ${opts.subject}`);
  if (opts.entity && opts.entityName) {
    head.push(`This call is about one ${opts.entity.name}: ${opts.entityName}. Extract the fields for this person only; if the evidence is about someone else, return nulls.`);
  } else if (opts.entity) {
    head.push(`Entity: ${opts.entity.name} (min ${opts.entity.min}, max ${opts.entity.max}). Return one entry per ${opts.entity.name}.`);
  }
  return [
    ...head,
    'Fields to extract:',
    ...fieldLines,
    '',
    'Evidence:',
    formatEvidence(opts.evidence),
  ].join('\n');
}

function toCandidate(name: string, raw: unknown): Candidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['value'] === null || r['value'] === undefined) return null;
  return {
    field: name,
    value: r['value'],
    quote: typeof r['quote'] === 'string' ? r['quote'] : '',
    source_ref: typeof r['source_ref'] === 'string' ? r['source_ref'].trim() : '',
    model_confidence: typeof r['confidence'] === 'number' ? r['confidence'] : undefined,
  };
}

function candidatesFromRecord(rec: unknown, fields: FieldSpecV2[]): Candidate[] {
  if (!rec || typeof rec !== 'object') return [];
  const r = rec as Record<string, unknown>;
  const out: Candidate[] = [];
  for (const f of fields) {
    const c = toCandidate(f.name, r[f.name]);
    if (c) out.push(c);
  }
  return out;
}

export function parseExtraction(json: unknown, fields: FieldSpecV2[], entity?: EntitySpecV2, perEntity = false): { fields: Candidate[]; entities: EntityCandidate[] } {
  if (!json || typeof json !== 'object') return { fields: [], entities: [] };
  const obj = json as Record<string, unknown>;

  if (entity && !perEntity) {
    const list = Array.isArray(obj['entities']) ? obj['entities'] : [];
    const entities: EntityCandidate[] = [];
    for (const rec of list) {
      const cands = candidatesFromRecord(rec, fields);
      const keyCand = cands.find((c) => c.field === entity.key);
      const name = keyCand ? String(keyCand.value) : '';
      if (!name) continue;
      entities.push({ name, fields: cands });
    }
    return { fields: [], entities };
  }

  const rec = obj['fields'] ?? obj;
  return { fields: candidatesFromRecord(rec, fields), entities: [] };
}

export interface RunExtractionOptions {
  extractor: Extractor;
  fields: FieldSpecV2[];
  evidence: EvidenceItem[];
  entity?: EntitySpecV2;
  entityName?: string;
  subject?: string;
}

export async function runExtraction(opts: RunExtractionOptions): Promise<ExtractionOutcome> {
  const perEntity = Boolean(opts.entityName);
  const schema = buildSchema(opts.fields, perEntity ? undefined : opts.entity);
  const system = buildSystemPrompt(perEntity ? undefined : opts.entity);
  const user = buildUserPrompt({
    fields: opts.fields,
    evidence: opts.evidence,
    entity: opts.entity,
    entityName: opts.entityName,
    subject: opts.subject,
  });
  const res = await opts.extractor.extract(schema, system, user, { maxTokens: 1024, temperature: 0 });
  const parsed = parseExtraction(res.json, opts.fields, opts.entity, perEntity);
  return { ...parsed, usage: res.usage, raw: res.raw };
}
