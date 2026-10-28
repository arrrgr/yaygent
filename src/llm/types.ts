/**
 * Extractor provider abstraction. One call = one JSON object shaped by a schema.
 */

export type JsonSchema = Record<string, unknown>;

export interface ExtractUsage {
  in: number;
  out: number;
  cost_usd: number;
}

export interface ExtractResult {
  json: unknown;
  usage: ExtractUsage;
  raw: string;
}

export interface ExtractOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface Extractor {
  provider: 'openrouter' | 'anthropic' | 'claude_code';
  model: string;
  extract(schema: JsonSchema, system: string, user: string, opts?: ExtractOptions): Promise<ExtractResult>;
}

/**
 * A provider-level failure that no retry and no other strategy can get past
 * (today: the Claude Code subscription limit). The cycle aborts the row instead
 * of finishing `partial` with empty data, because an empty row used to be
 * written to the result cache for 24h - which reintroduced exactly what the
 * fail-fast existed to prevent (review 2.3). `statusCode` is 4xx so the batch
 * runner does not retry it.
 */
export class ProviderUnrecoverableError extends Error {
  readonly statusCode = 429;
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = 'ProviderUnrecoverableError';
    this.provider = provider;
  }
}

export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
