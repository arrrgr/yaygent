/**
 * JSON repair for model output that is almost-JSON: fences, channel tags,
 * leading prose. Ported from the balanced-scan in agent/loop.ts.
 */

export function extractJsonObject(content: string): string | null {
  const clean = content
    .replace(/<\|[^>]+?\|>/g, '')
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

/** Parse model text into JSON, repairing fences and stray prose. Returns null if hopeless. */
export function parseJsonLoose(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // fall through to repair
  }
  const candidate = extractJsonObject(content);
  if (candidate === null) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
