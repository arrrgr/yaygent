/**
 * Per-model USD prices per million tokens for providers that do not return
 * cost in the response (Anthropic). OpenRouter returns usage.cost directly.
 */

interface Price {
  in: number;
  out: number;
}

const ANTHROPIC_PRICES: Array<{ match: RegExp; price: Price }> = [
  { match: /haiku-4-5/, price: { in: 1, out: 5 } },
  { match: /sonnet-5/, price: { in: 2, out: 10 } },
  { match: /sonnet-4-6/, price: { in: 3, out: 15 } },
  { match: /sonnet-4-5/, price: { in: 3, out: 15 } },
  { match: /opus-5/, price: { in: 5, out: 25 } },
  { match: /opus-4-[678]/, price: { in: 5, out: 25 } },
];

// Unknown model: assume the most expensive tier we route to, so the cost cap
// errs on the side of stopping early.
const ANTHROPIC_FALLBACK: Price = { in: 5, out: 25 };

export function anthropicCostUsd(model: string, inTokens: number, outTokens: number): number {
  const row = ANTHROPIC_PRICES.find((p) => p.match.test(model));
  const price = row ? row.price : ANTHROPIC_FALLBACK;
  return (inTokens * price.in + outTokens * price.out) / 1_000_000;
}
