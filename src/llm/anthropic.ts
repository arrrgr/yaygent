/**
 * Anthropic extractor: Messages API with one forced tool whose input_schema is
 * the field schema, so the shape is guaranteed by the API.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicCostUsd } from './pricing.js';
import type { ExtractOptions, ExtractResult, Extractor, JsonSchema } from './types.js';

const TOOL_NAME = 'emit_fields';

export function createAnthropicExtractor(apiKey: string, model: string): Extractor {
  const client = new Anthropic({ apiKey, maxRetries: 2 });

  return {
    provider: 'anthropic',
    model,
    async extract(schema: JsonSchema, system: string, user: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
      const response = await client.messages.create(
        {
          model,
          max_tokens: opts.maxTokens ?? 1024,
          temperature: opts.temperature ?? 0,
          system,
          tools: [
            {
              name: TOOL_NAME,
              description: 'Emit the extracted fields. Every value must come from the evidence.',
              input_schema: schema as Anthropic.Tool['input_schema'],
            },
          ],
          tool_choice: { type: 'tool', name: TOOL_NAME },
          messages: [{ role: 'user', content: user }],
        },
        { timeout: opts.timeoutMs ?? 60_000 }
      );

      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === TOOL_NAME
      );
      if (!toolUse) {
        throw new Error(`[llm] Anthropic returned no ${TOOL_NAME} tool call (stop_reason ${response.stop_reason})`);
      }

      const inTokens = response.usage.input_tokens;
      const outTokens = response.usage.output_tokens;
      return {
        json: toolUse.input,
        raw: JSON.stringify(toolUse.input),
        usage: { in: inTokens, out: outTokens, cost_usd: anthropicCostUsd(model, inTokens, outTokens) },
      };
    },
  };
}
