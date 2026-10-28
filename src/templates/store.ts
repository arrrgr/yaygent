import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { isV2, parseTemplateV2, type TemplateV2 } from './v2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Templates dir is templates/ - two levels up from src/templates/
const TEMPLATES_DIR = path.join(__dirname, '../../templates');
// v1 (react-loop) copies of templates that were ported to v2 live here. They
// are served when a request says `mode: react` for a v2 template name.
const V1_DIR = path.join(TEMPLATES_DIR, 'v1');

export interface Template {
  name: string;
  description: string;
  model: string;
  max_turns: number;
  variables: string[];
  system_prompt: string;
  user_prompt: string;
  output_format?: string;
}

export type TemplateAny = { version: 1; t: Template } | { version: 2; t: TemplateV2 };

const REQUIRED_FIELDS: Array<keyof Template> = ['name', 'system_prompt', 'user_prompt'];

function ensureTemplatesDir(): void {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  }
}

/**
 * Template names come straight off the request body and are joined onto a
 * directory. `template: "../../../../tmp/x"` used to read outside templates/ and
 * POST /v1/templates used to WRITE attacker-supplied YAML to an arbitrary path
 * inside the container (review 3.9).
 */
const TEMPLATE_NAME_RE = /^[a-z0-9_-]+$/i;

export function isValidTemplateName(name: string): boolean {
  return typeof name === 'string' && TEMPLATE_NAME_RE.test(name);
}

function assertTemplateName(name: string): void {
  if (!isValidTemplateName(name)) {
    throw Object.assign(new Error(`Invalid template name: ${String(name)}`), { statusCode: 400 });
  }
}

function templatePath(name: string): string {
  assertTemplateName(name);
  return path.join(TEMPLATES_DIR, `${name}.yaml`);
}

function v1TemplatePath(name: string): string {
  assertTemplateName(name);
  return path.join(V1_DIR, `${name}.yaml`);
}

function loadYaml(yamlContent: string): unknown {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlContent);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid YAML: ${msg}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('YAML must be an object at root level');
  }
  return parsed;
}

function parseV1(parsed: unknown): Template {
  const obj = parsed as Record<string, unknown>;

  const missing = REQUIRED_FIELDS.filter((f) => !obj[f]);
  if (missing.length > 0) {
    throw new Error(`Template missing required fields: ${missing.join(', ')}`);
  }

  return {
    name: String(obj.name),
    description: obj.description ? String(obj.description) : '',
    model: obj.model ? String(obj.model) : 'openai/gpt-oss-120b',
    max_turns: typeof obj.max_turns === 'number' ? obj.max_turns : 6,
    variables: Array.isArray(obj.variables)
      ? obj.variables.map((v: unknown) => String(v))
      : [],
    system_prompt: String(obj.system_prompt),
    user_prompt: String(obj.user_prompt),
    output_format: obj.output_format ? String(obj.output_format) : undefined,
  };
}

/** Parse either template version. */
export function parseAny(yamlContent: string): TemplateAny {
  const parsed = loadYaml(yamlContent);
  if (isV2(parsed)) return { version: 2, t: parseTemplateV2(parsed) };
  return { version: 1, t: parseV1(parsed) };
}

function parseAndValidate(yamlContent: string): Template {
  return parseV1(loadYaml(yamlContent));
}

/** Summary shape shared by both versions (used by the templates routes). */
export interface TemplateSummary {
  name: string;
  description: string;
  model: string | undefined;
  variables: string[];
  version: 1 | 2;
}

export function summarize(t: TemplateAny): TemplateSummary {
  return t.version === 1
    ? { name: t.t.name, description: t.t.description, model: t.t.model, variables: t.t.variables, version: 1 }
    : { name: t.t.name, description: t.t.description, model: t.t.model, variables: t.t.variables, version: 2 };
}

export function listTemplatesAny(): TemplateAny[] {
  ensureTemplatesDir();
  const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.yaml'));
  const templates: TemplateAny[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf-8');
      templates.push(parseAny(content));
    } catch {
      // Skip malformed templates silently during list
    }
  }

  return templates;
}

/** v1-shaped listing kept for existing callers; v2 templates are omitted. */
export function listTemplates(): Template[] {
  return listTemplatesAny()
    .filter((t): t is { version: 1; t: Template } => t.version === 1)
    .map((t) => t.t);
}

export function getTemplateAny(name: string): TemplateAny | null {
  ensureTemplatesDir();
  if (!isValidTemplateName(name)) return null;
  const filePath = templatePath(name);
  if (!fs.existsSync(filePath)) return null;
  return parseAny(fs.readFileSync(filePath, 'utf-8'));
}

/** v1 template by name. Looks in templates/ first, then templates/v1/ (react-mode copies). */
export function getTemplate(name: string): Template | null {
  if (!isValidTemplateName(name)) return null;
  const any = getTemplateAny(name);
  if (any && any.version === 1) return any.t;
  const v1Path = v1TemplatePath(name);
  if (fs.existsSync(v1Path)) return parseAndValidate(fs.readFileSync(v1Path, 'utf-8'));
  return null;
}

/** v2 template by name, or null when absent or v1. */
export function getTemplateV2(name: string): TemplateV2 | null {
  const any = getTemplateAny(name);
  return any && any.version === 2 ? any.t : null;
}

export function saveTemplate(name: string, yamlContent: string): void {
  ensureTemplatesDir();
  // Validate before writing (either version)
  parseAny(yamlContent);
  fs.writeFileSync(templatePath(name), yamlContent, 'utf-8');
}

export function templateExists(name: string): boolean {
  ensureTemplatesDir();
  if (!isValidTemplateName(name)) return false;
  return fs.existsSync(templatePath(name));
}

/** Validate YAML of either version; returns the summary shape. */
export function validateYaml(yamlContent: string): TemplateSummary {
  return summarize(parseAny(yamlContent));
}
