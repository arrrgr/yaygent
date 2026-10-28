/**
 * Extractor providers (selected by LLM_PROVIDER, default openrouter):
 *
 *  - openrouter   Chat Completions with response_format json_schema + JSON
 *                 repair. Default model openai/gpt-oss-120b. Cost from
 *                 usage.cost. Needs OPENROUTER_API_KEY.
 *  - anthropic    Messages API with one forced tool (emit_fields) whose
 *                 input_schema is the field schema. Default model
 *                 claude-haiku-4-5-20251001. Cost from the price table in
 *                 pricing.ts. Needs ANTHROPIC_API_KEY.
 *  - claude_code  Spawns the local `claude -p` CLI on the Claude Code
 *                 subscription (no API key). Models haiku|sonnet. Cost is
 *                 list-price accounting only (`_meta.cost_basis:
 *                 'subscription'`). Needs the CLI on PATH or CLAUDE_CODE_BIN;
 *                 CLAUDE_CODE_CONCURRENCY caps parallel spawns (default 4).
 *
 * The react loop keeps its own LLMClient in agent/llm.ts; this module only
 * serves the cycle engine's extract step.
 */

import { createAnthropicExtractor } from './anthropic.js';
import { claudeCodeModel, createClaudeCodeExtractor, type ClaudeCodeOptions } from './claude_code.js';
import { createOpenRouterExtractor } from './openrouter.js';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENROUTER_MODEL, type Extractor } from './types.js';

export type { Extractor, ExtractResult, ExtractOptions, ExtractUsage, JsonSchema } from './types.js';
export { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENROUTER_MODEL, ProviderUnrecoverableError } from './types.js';
export { parseJsonLoose, extractJsonObject } from './json_repair.js';
export { anthropicCostUsd } from './pricing.js';
export { claudeCodeModel, createClaudeCodeExtractor, CLAUDE_CODE_DEFAULT_MODEL } from './claude_code.js';

export type Provider = 'openrouter' | 'anthropic' | 'claude_code';

export const PROVIDERS: Provider[] = ['openrouter', 'anthropic', 'claude_code'];

export interface ExtractorKeys {
  openrouterApiKey?: string;
  anthropicApiKey?: string;
  claudeCode?: ClaudeCodeOptions;
}

/**
 * Pick the extractor model: request > template > provider default. An
 * OpenRouter id (contains "/") on the anthropic provider is replaced by the
 * Anthropic default, since it cannot be served there. claude_code maps every
 * id onto haiku|sonnet.
 */
export function resolveExtractorModel(provider: Provider, requested?: string, templateModel?: string): string {
  const candidate = requested || templateModel || '';
  if (provider === 'claude_code') return claudeCodeModel(candidate);
  if (provider === 'anthropic') {
    return candidate && !candidate.includes('/') ? candidate : DEFAULT_ANTHROPIC_MODEL;
  }
  return candidate || DEFAULT_OPENROUTER_MODEL;
}

export function createExtractor(provider: Provider, model: string, keys: ExtractorKeys = {}): Extractor {
  if (provider === 'claude_code') return createClaudeCodeExtractor(model, keys.claudeCode);
  if (provider === 'anthropic') {
    const key = keys.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!key) throw new Error('ANTHROPIC_API_KEY is required for the anthropic extractor');
    return createAnthropicExtractor(key, model);
  }
  const key = keys.openrouterApiKey ?? process.env['OPENROUTER_API_KEY'];
  if (!key) throw new Error('OPENROUTER_API_KEY is required for the openrouter extractor');
  return createOpenRouterExtractor(key, model);
}
