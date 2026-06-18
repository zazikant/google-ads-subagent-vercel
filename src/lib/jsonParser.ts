/**
 * Robust JSON parser for LLM outputs.
 *
 * Recovery chain (ported from atomic-graph-opencode):
 *   1. Strip markdown code fences
 *   2. Try direct parse
 *   3. Extract balanced JSON via bracket matching
 *   4. Fix trailing commas
 *   5. Greedy regex fallback
 */
export function parseLLMJson<T>(raw: string): T {
  const cleaned = stripFence(raw);

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // fall through
  }

  const balanced = extractBalancedJSON(cleaned);
  if (balanced) {
    try {
      return JSON.parse(balanced) as T;
    } catch {
      // fall through
    }
    try {
      return JSON.parse(balanced.replace(/,\s*([}\]])/g, '$1')) as T;
    } catch {
      // fall through
    }
  }

  const greedy = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (greedy) {
    try {
      return JSON.parse(greedy[1]) as T;
    } catch {
      // fall through
    }
  }

  throw new Error(
    `Failed to parse LLM JSON. Output length: ${raw.length} chars.\n` +
      `First 200 chars: ${raw.slice(0, 200)}\n` +
      `Last 200 chars: ${raw.slice(-200)}`,
  );
}

function stripFence(raw: string): string {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  return cleaned;
}

function extractBalancedJSON(text: string): string | null {
  const startCurly = text.indexOf('{');
  const startSquare = text.indexOf('[');

  let startIdx: number;
  let closeCh: string;

  if (startCurly === -1 && startSquare === -1) return null;
  if (startCurly === -1) {
    startIdx = startSquare;
    closeCh = ']';
  } else if (startSquare === -1) {
    startIdx = startCurly;
    closeCh = '}';
  } else if (startCurly < startSquare) {
    startIdx = startCurly;
    closeCh = '}';
  } else {
    startIdx = startSquare;
    closeCh = ']';
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && (ch === closeCh)) {
        return text.slice(startIdx, i + 1);
      } else if (depth === 0) {
        // We hit the wrong closing brace for what we started with; keep scanning.
      }
      if (depth < 0) return null;
    }
  }

  return null;
}

/** Strip markdown fences and surrounding quotes from a free-form text reply. */
export function cleanText(raw: string): string {
  return raw
    .replace(/^```[\w]*\n?/m, '')
    .replace(/\n?```$/m, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}
