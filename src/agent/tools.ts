/**
 * Tool definitions in OpenAI function-calling format, and the tool dispatcher.
 */

import { search, type SearchResult } from '../browser/search.js';
import { visitPage } from '../browser/visit.js';
import type { BrowserPool } from '../browser/pool.js';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for information about a company. Use when you need to find executives, contact info, funding, tech stack, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'visit_webpage',
      description:
        'Visit a URL and read question-focused evidence from its content. Use with a specific question such as what the company does, who its customers are, or what recent news is on the page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to visit' },
          question: {
            type: 'string',
            description: 'What you are looking for on this page',
          },
        },
        required: ['url'],
      },
    },
  },
] as const;

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map(
      (r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}`
    )
    .join('\n\n');
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  pool: BrowserPool
): Promise<string> {
  if (name === 'web_search') {
    const query = (args['query'] as string) || '';
    const results = await search(query, pool);
    return formatSearchResults(results);
  }

  if (name === 'visit_webpage') {
    const url = (args['url'] as string) || '';
    const question = (args['question'] as string) || undefined;
    return visitPage(url, pool, question);
  }

  return `Unknown tool: ${name}`;
}
