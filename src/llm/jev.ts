/**
 * Jev (jevtypesafeai.com): a typed classifier that returns labels with a confidence, never text.
 * Used by the `jev` strategy for enum fields (research-ops-kit's first pass: homepage text -> Jev,
 * anything below the confidence floor goes on to the extractor). Fails open: any error returns null
 * and the cycle carries on with its other strategies.
 */

export interface JevQuestion {
  instructions: string;
  criteria: Record<string, string>;
}

export interface JevAnswer {
  choice: string;
  confidence: number;
}

export type Decider = (
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>
) => Promise<{ answers: Record<string, JevAnswer>; cost_usd: number } | null>;

const JEV_URL = 'https://jevtypesafeai.com/api/v1/decide';
const JEV_MODEL = 'jev-1.13.0';

export function createJevDecider(apiKey: string, fetchImpl: typeof fetch = fetch): Decider {
  return async (state, questions) => {
    const body = {
      model: JEV_MODEL,
      state,
      questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: 'choice', ...q }])),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchImpl(JEV_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const d = (await res.json()) as { answers?: Record<string, JevAnswer>; usage?: { cost_usd?: number } };
          if (!d.answers) return null;
          return { answers: d.answers, cost_usd: Number(d.usage?.cost_usd ?? 0) };
        }
        if (res.status !== 429 && res.status < 500) {
          console.warn(`[jev] ${res.status}; skipping`);
          return null;
        }
      } catch (err) {
        console.warn(`[jev] ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    return null;
  };
}
