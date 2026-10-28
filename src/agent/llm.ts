/**
 * OpenRouter LLM client with cost tracking and retry logic.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LLMResponse {
  content: string;
  tool_calls: ToolCall[];
  stop_reason: string;
  usage: { prompt_tokens: number; completion_tokens: number; cost_usd: number };
}

interface OpenRouterResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMClient {
  private apiKey: string;
  private model: string;
  private _totalCost = 0;
  private _totalCalls = 0;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async call(
    messages: LLMMessage[],
    options: {
      maxTokens?: number;
      temperature?: number;
      tools?: object[];
    } = {}
  ): Promise<LLMResponse> {
    const { maxTokens = 1024, temperature = 0.1, tools } = options;

    // Build payload
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      payload['tools'] = tools;
    }

    // Add reasoning effort for o1/o3/gpt-oss models
    if (
      this.model.includes('o1') ||
      this.model.includes('o3') ||
      this.model.includes('gpt-oss')
    ) {
      payload['reasoning'] = { effort: 'low' };
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60_000);

        let response: Response;
        try {
          response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/arrrgr/yaygent',
              'X-Title': 'Slaygent',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        // Handle 429 rate limit
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (attempt + 1) * 2000;
          console.warn(`[llm] Rate limited (429), waiting ${waitMs}ms before retry ${attempt + 1}`);
          await sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`OpenRouter error ${response.status}: ${body}`);
        }

        const data = (await response.json()) as OpenRouterResponse;
        this._totalCalls++;

        const choice = data.choices?.[0];
        if (!choice) {
          throw new Error('OpenRouter returned no choices');
        }

        const content = choice.message.content ?? '';
        const rawToolCalls = choice.message.tool_calls ?? [];

        const tool_calls: ToolCall[] = rawToolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));

        const promptTokens = data.usage?.prompt_tokens ?? 0;
        const completionTokens = data.usage?.completion_tokens ?? 0;
        // OpenRouter returns cost in USD directly in usage.cost
        const costUsd = (data.usage as Record<string, unknown>)?.cost as number ?? 0;
        this._totalCost += costUsd;

        return {
          content,
          tool_calls,
          stop_reason: choice.finish_reason ?? '',
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            cost_usd: costUsd,
          },
        };
      } catch (err) {
        const error = err as Error;
        // Handle timeout / abort
        if (error.name === 'AbortError' || error.message.includes('abort')) {
          console.warn(`[llm] Timeout on attempt ${attempt + 1}`);
          lastError = new Error('LLM request timed out');
          if (attempt < 2) {
            await sleep((attempt + 1) * 1000);
            continue;
          }
        } else {
          lastError = error;
          if (attempt < 2) {
            await sleep((attempt + 1) * 1000);
            continue;
          }
        }
        break;
      }
    }

    throw lastError ?? new Error('LLM call failed after 3 attempts');
  }

  get totalCost(): number {
    return this._totalCost;
  }

  get totalCalls(): number {
    return this._totalCalls;
  }
}
