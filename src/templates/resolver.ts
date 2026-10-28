import { type Template } from './store.js';

/**
 * Returns array of variable names declared in the template that are missing from inputs.
 * Empty array means all variables are present.
 */
export function validateInputs(
  template: Template,
  inputs: Record<string, string>
): string[] {
  return template.variables.filter((v) => !(v in inputs));
}

/**
 * Resolves all {{variable_name}} placeholders in a prompt string using the provided inputs.
 * Does a simple global string replacement - all occurrences of each variable are replaced.
 */
function replacePlaceholders(text: string, inputs: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(inputs)) {
    // Replace all occurrences of {{key}} with the value
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function formatInputBlock(template: Template, inputs: Record<string, string>): string {
  const lines = template.variables.map((key) => `- ${key}: ${inputs[key] ?? ''}`);
  return `Input data:\n${lines.join('\n')}`;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function subtractMonths(date: Date, months: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}

function needsDateContext(prompt: string): boolean {
  return /\b(recent|last\s+\d+\s+months?|news|today|current date)\b/i.test(prompt);
}

function formatRuntimeContext(prompt: string): string {
  if (!needsDateContext(prompt)) return '';

  const today = new Date();
  const newsCutoff = subtractMonths(today, 6);
  return [
    `Current date: ${formatDate(today)}`,
    `Six-month news cutoff: ${formatDate(newsCutoff)}`,
  ].join('\n');
}

/**
 * Resolves template.user_prompt by injecting all input variables.
 * Throws a descriptive error if any declared variables are missing from inputs.
 * Returns the fully resolved prompt string.
 */
export function resolvePrompt(
  template: Template,
  inputs: Record<string, string>
): string {
  const missing = validateInputs(template, inputs);
  if (missing.length > 0) {
    throw new Error(
      `Missing required variables: ${missing.join(', ')}`
    );
  }

  const prompt = replacePlaceholders(template.user_prompt, inputs).trimEnd();
  const runtimeContext = formatRuntimeContext(prompt);
  const blocks = [prompt, runtimeContext, formatInputBlock(template, inputs)].filter(Boolean);
  return blocks.join('\n\n');
}
