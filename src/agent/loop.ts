/**
 * ReAct agent loop - the brain of Slaygent.
 * Two modes: function calling (primary) and JSON action fallback.
 */

import type { BrowserPool } from '../browser/pool.js';
import { LLMClient, type LLMMessage } from './llm.js';
import { TOOLS, executeTool, formatSearchResults } from './tools.js';
import { search } from '../browser/search.js';
import { visitPage } from '../browser/visit.js';

export interface AgentStep {
  type: 'search' | 'visit' | 'error' | 'profile_cache' | 'profile_scrape';
  query?: string;
  url?: string;
  question?: string;
  results_count?: number;
  chars_read?: number;
  reasoning?: string;
  snippets?: string;
  // cycle-mode additions (absent on react steps)
  cycle?: number;
  strategy?: number;
  strategy_type?: string;
  entity?: string;
  fields_targeted?: string[];
  locked?: string[];
  rejected?: Array<{ field: string; reason: string }>;
  tier?: string;
  cached?: boolean;
  cost_usd?: number;
  tokens?: { in: number; out: number };
  elapsed_ms?: number;
}

export interface AgentResult {
  result: string;
  steps: AgentStep[];
  turns: number;
  status: 'completed' | 'completed_max_turns' | 'error';
  cost_usd: number;
  model: string;
}

interface RunAgentOptions {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTurns: number;
  pool: BrowserPool;
  apiKey: string;
  outputFormat?: 'text' | 'json';
}

const MAX_CONSECUTIVE_EMPTY_SEARCHES = 3;

function buildCompactFinalMessages(
  systemPrompt: string,
  userPrompt: string,
  steps: AgentStep[],
  outputFormat?: 'text' | 'json'
): LLMMessage[] {
  const observations = steps
    .map((step, index) => {
      const label = step.type === 'search'
        ? `Search: ${step.query ?? ''}`
        : step.type === 'visit'
          ? `Visit: ${step.url ?? ''}`
          : `Error: ${step.query ?? step.url ?? ''}`;
      const body = step.snippets ? step.snippets.slice(0, 1500) : '';
      return `${index + 1}. ${label}\n${body}`;
    })
    .join('\n\n');

  const formatInstruction = outputFormat === 'json'
    ? 'Return valid JSON only, using the exact schema requested. Use "n/a" for missing fields.'
    : 'Return the best final answer using only the observations below.';

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `${userPrompt}\n\nResearch observations:\n${observations}\n\n${formatInstruction}\nDo not emit channel tags, markdown fences, tool calls, or commentary.`,
    },
  ];
}

function extractJsonObject(content: string): string | null {
  const clean = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let depth = 0;
  let start = -1;
  let opener = '';
  let closer = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if ((char === '{' || char === '[') && depth === 0) {
      start = i;
      opener = char;
      closer = char === '{' ? '}' : ']';
      depth++;
    } else if (char === opener) {
      depth++;
    } else if (char === closer) {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = clean.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          start = -1;
          opener = '';
          closer = '';
        }
      }
    }
  }

  return null;
}

function normalizeFinalContent(content: string, outputFormat?: 'text' | 'json'): string {
  if (outputFormat === 'json') {
    return extractJsonObject(content) ?? content.trim();
  }

  return content.replace(/<\|[^>]+?\|>/g, '').trim();
}

function isUsableFinalContent(content: string, outputFormat?: 'text' | 'json'): boolean {
  const normalized = normalizeFinalContent(content, outputFormat);
  if (!normalized) return false;
  if (normalized.includes('<|channel|>') || normalized.includes('<|message|>')) return false;
  if (outputFormat !== 'json') return true;
  return extractJsonObject(normalized) !== null;
}

/**
 * Primary agent mode using OpenAI-style function calling.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { systemPrompt, userPrompt, model, maxTurns, pool, apiKey, outputFormat } = options;

  const llm = new LLMClient(apiKey, model);
  const steps: AgentStep[] = [];

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // First call to detect mode
  const firstResponse = await llm.call(messages, {
    tools: TOOLS as unknown as object[],
    maxTokens: 1024,
  });

  // Auto-detect: if no tool_calls and content looks like a JSON action, switch to simple mode
  if (
    firstResponse.tool_calls.length === 0 &&
    firstResponse.content.trimStart().startsWith('{') &&
    firstResponse.content.includes('"action"')
  ) {
    return runAgentSimple(options);
  }

  // Function calling mode - process first response
  let currentResponse = firstResponse;
  let turns = 0;
  let consecutiveEmptySearches = 0;

  // Process first response plus up to (maxTurns - 1) more iterations
  for (let iteration = 0; iteration < maxTurns; iteration++) {
    turns = iteration + 1;

    if (currentResponse.tool_calls.length > 0) {
      let shouldStopResearch = false;

      // Append assistant message with tool_calls
      messages.push({
        role: 'assistant',
        content: currentResponse.content ?? '',
        tool_calls: currentResponse.tool_calls,
      });

      // Capture LLM reasoning before tool calls
      const reasoning = currentResponse.content?.trim() || undefined;

      // Execute each tool call
      for (const tc of currentResponse.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }

        const toolResult = await executeTool(tc.function.name, args, pool);

        // Record step
        if (tc.function.name === 'web_search') {
          const query = (args['query'] as string) || '';
          const resultCount = toolResult === 'No results found.'
            ? 0
            : (toolResult.match(/^\d+\./gm) || []).length;
          consecutiveEmptySearches = resultCount === 0 ? consecutiveEmptySearches + 1 : 0;
          if (consecutiveEmptySearches >= MAX_CONSECUTIVE_EMPTY_SEARCHES) {
            shouldStopResearch = true;
          }
          steps.push({ type: 'search', query, results_count: resultCount, reasoning, snippets: toolResult });
        } else if (tc.function.name === 'visit_webpage') {
          const url = (args['url'] as string) || '';
          const question = (args['question'] as string) || undefined;
          consecutiveEmptySearches = 0;
          steps.push({ type: 'visit', url, question, chars_read: toolResult.length, reasoning, snippets: toolResult.slice(0, 2000) });
        } else {
          steps.push({ type: 'error', query: tc.function.name, reasoning });
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolResult,
        });
      }

      if (shouldStopResearch) {
        messages.push({
          role: 'user',
          content:
            'Multiple searches returned no results. Stop searching and give the best valid final answer from the evidence already collected. Use "n/a" for fields without evidence.',
        });
        break;
      }

      // Next iteration
      if (iteration < maxTurns - 1) {
        currentResponse = await llm.call(messages, {
          tools: TOOLS as unknown as object[],
          maxTokens: 1024,
        });
        continue;
      }

      // Reached maxTurns while still calling tools - force answer
      break;
    } else if (currentResponse.content) {
      // Final answer
      const result = normalizeFinalContent(currentResponse.content, outputFormat);
      if (outputFormat === 'json' && !isUsableFinalContent(result, outputFormat)) {
        messages.push({ role: 'assistant', content: currentResponse.content });
        messages.push({
          role: 'user',
          content:
            'Your previous answer was not valid JSON. Return valid JSON only, using the exact schema requested. No markdown, channel tags, commentary, or explanation.',
        });
        currentResponse = await llm.call(messages, { maxTokens: 2048 });
        if (!isUsableFinalContent(currentResponse.content, outputFormat)) {
          break;
        }
      }

      return {
        result: normalizeFinalContent(currentResponse.content, outputFormat),
        steps,
        turns,
        status: 'completed',
        cost_usd: llm.totalCost,
        model,
      };
    } else {
      // Empty content, no tool calls - nudge
      if (iteration < maxTurns - 1) {
        messages.push({
          role: 'user',
          content: 'Please provide your final answer now.',
        });
        currentResponse = await llm.call(messages, {
          tools: TOOLS as unknown as object[],
          maxTokens: 1024,
        });
        continue;
      }
      break;
    }
  }

  // Force final answer after exhausting turns
  const forceMsg = outputFormat === 'json'
    ? "You've done enough research. Give your final answer now as valid JSON only - no markdown, no explanation. Use the exact JSON schema specified in the original prompt. Fill in what you found; use \"n/a\" for anything missing."
    : "You've done enough research. Give your final answer now. If you couldn't find the info, say what you found.";

  messages.push({ role: 'user', content: forceMsg });

  let finalResponse = await llm.call(messages, { maxTokens: 2048 });

  if (!isUsableFinalContent(finalResponse.content, outputFormat)) {
    finalResponse = await llm.call(
      buildCompactFinalMessages(systemPrompt, userPrompt, steps, outputFormat),
      { maxTokens: 2048 }
    );
  }

  if (!isUsableFinalContent(finalResponse.content, outputFormat)) {
    finalResponse = await llm.call(
      [
        {
          role: 'system',
          content:
            'You repair failed agent outputs. Return only the requested final answer. For JSON tasks, return valid JSON only.',
        },
        {
          role: 'user',
          content:
            `${userPrompt}\n\nThe collected observations were:\n` +
            `${steps.map((s, i) => `${i + 1}. ${s.type} ${s.query ?? s.url ?? ''}\n${(s.snippets ?? '').slice(0, 1200)}`).join('\n\n')}\n\n` +
            `The previous output was invalid:\n${finalResponse.content}\n\n` +
            'Return the final answer now as valid JSON only. Use the exact schema requested and "n/a" for missing fields.',
        },
      ],
      { maxTokens: 2048 }
    );
  }

  return {
    result: normalizeFinalContent(finalResponse.content, outputFormat) || 'Unknown',
    steps,
    turns: maxTurns,
    status: 'completed_max_turns',
    cost_usd: llm.totalCost,
    model,
  };
}

/**
 * JSON action fallback mode - for models that don't support function calling.
 * LLM outputs: {"action": "search", "query": "..."} or
 *              {"action": "visit", "url": "...", "question": "..."} or
 *              {"action": "answer", "result": "..."}
 */
export async function runAgentSimple(options: RunAgentOptions): Promise<AgentResult> {
  const { systemPrompt: _systemPrompt, userPrompt, model, maxTurns, pool, apiKey } = options;

  const llm = new LLMClient(apiKey, model);
  const steps: AgentStep[] = [];

  const jsonSystemPrompt = `You are a company research agent. Research the following request by searching the web.

You can take actions by responding with JSON:
1. Search the web: {"action": "search", "query": "your search query"}
2. Visit a webpage: {"action": "visit", "url": "https://...", "question": "what to find"}
3. Give final answer: {"action": "answer", "result": "your final answer"}

Rules:
- Respond with ONLY the JSON action, nothing else
- Start by searching for relevant information
- Use visit only for promising links
- Max 2 page visits per task
- After gathering enough info, use the answer action
- If you cannot find info, still use answer action`;

  const messages: LLMMessage[] = [
    { role: 'system', content: jsonSystemPrompt },
    { role: 'user', content: userPrompt },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await llm.call(messages, { maxTokens: 512 });
    const content = response.content;

    if (!content) break;

    // Parse JSON action
    let action: Record<string, unknown> | null = null;
    try {
      const clean = content
        .trim()
        .replace(/^```[a-z]*\n?/, '')
        .replace(/```$/, '')
        .trim();

      // Handle concatenated JSON objects - find answer action or take the last one
      const jsonObjects: string[] = [];
      let depth = 0;
      let start: number | null = null;
      for (let i = 0; i < clean.length; i++) {
        const c = clean[i];
        if (c === '{') {
          if (depth === 0) start = i;
          depth++;
        } else if (c === '}') {
          depth--;
          if (depth === 0 && start !== null) {
            jsonObjects.push(clean.slice(start, i + 1));
            start = null;
          }
        }
      }

      if (jsonObjects.length > 0) {
        // Prefer 'answer' action if present
        for (const obj of [...jsonObjects].reverse()) {
          try {
            const parsed = JSON.parse(obj) as Record<string, unknown>;
            if (parsed['action'] === 'answer') {
              action = parsed;
              break;
            }
          } catch {
            // skip
          }
        }
        if (!action) {
          action = JSON.parse(jsonObjects[0]) as Record<string, unknown>;
        }
      } else {
        action = JSON.parse(clean) as Record<string, unknown>;
      }
    } catch {
      // Not JSON - treat as final answer
      return {
        result: content,
        steps,
        turns: turn + 1,
        status: 'completed',
        cost_usd: llm.totalCost,
        model,
      };
    }

    const act = action['action'] as string;

    if (act === 'search') {
      const query = (action['query'] as string) || '';
      const results = await search(query, pool);
      const formatted = formatSearchResults(results);
      steps.push({ type: 'search', query, results_count: results.length });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `Search results:\n${formatted}\n\nWhat's your next action?`,
      });
    } else if (act === 'visit') {
      const url = (action['url'] as string) || '';
      const question = (action['question'] as string) || undefined;
      const pageText = await visitPage(url, pool, question);
      steps.push({ type: 'visit', url, question, chars_read: pageText.length });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `Page content:\n${pageText}\n\nWhat's your next action?`,
      });
    } else if (act === 'answer') {
      const result = (action['result'] as string) || content;
      return {
        result,
        steps,
        turns: turn + 1,
        status: 'completed',
        cost_usd: llm.totalCost,
        model,
      };
    } else {
      // Unknown action, treat as final answer
      return {
        result: content,
        steps,
        turns: turn + 1,
        status: 'completed',
        cost_usd: llm.totalCost,
        model,
      };
    }
  }

  return {
    result: 'Unknown - max turns reached',
    steps,
    turns: maxTurns,
    status: 'completed_max_turns',
    cost_usd: llm.totalCost,
    model,
  };
}
