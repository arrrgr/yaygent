/**
 * OpenRouter extractor: chat completion with response_format json_schema plus
 * a JSON repair pass. Fetch/retry logic mirrors agent/llm.ts (kept separate so
 * the react loop's LLMClient stays untouched).
 */

import { parseJsonLoose } from './json_repair.js';
import { sleep, type ExtractOptions, type ExtractResult, type Extractor, type JsonSchema } from './types.js';

interface OpenRouterCompletion {
  choices?: Array<{ message: { content: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export function createOpenRouterExtractor(apiKey: string, model: string): Extractor {
  return {
    provider: 'openrouter',
    model,
    async extract(schema: JsonSchema, system: string, user: string, opts: ExtractOptions = {}): Promise<ExtractResult> {
      const payload: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'emit_fields', strict: true, schema },
        },
      };
      if (/gpt-oss|o1|o3/.test(model)) payload['reasoning'] = { effort: 'low' };

      const data = await postWithRetry(apiKey, payload, opts.timeoutMs ?? 60_000);
      const raw = data.choices?.[0]?.message?.content ?? '';
      const json = parseJsonLoose(raw);
      if (json === null) {
        throw new Error(`[llm] OpenRouter returned non-JSON content: ${raw.slice(0, 200)}`);
      }
      return {
        json,
        raw,
        usage: {
          in: data.usage?.prompt_tokens ?? 0,
          out: data.usage?.completion_tokens ?? 0,
          cost_usd: data.usage?.cost ?? 0,
        },
      };
    },
  };
}

async function postWithRetry(apiKey: string, payload: unknown, timeoutMs: number): Promise<OpenRouterCompletion> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/arrrgr/yaygent',
          'X-Title': 'Yaygent',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (attempt + 1) * 2000;
        console.warn(`[llm] OpenRouter 429, waiting ${waitMs}ms (attempt ${attempt + 1})`);
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error(`OpenRouter error ${response.status}: ${body.slice(0, 300)}`);
        // 4xx other than 429 will not get better on retry
        if (response.status >= 400 && response.status < 500) throw err;
        lastError = err;
      } else {
        const data = (await response.json()) as OpenRouterCompletion;
        if (!data.choices?.[0]) throw new Error('OpenRouter returned no choices');
        return data;
      }
    } catch (err) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        lastError = new Error('OpenRouter request timed out');
      } else if (/OpenRouter error 4\d\d/.test(error.message)) {
        throw error;
      } else {
        lastError = error;
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await sleep((attempt + 1) * 1000);
  }

  throw lastError ?? new Error('OpenRouter call failed after 3 attempts');
}
