/**
 * Robust JSON parser for LLM outputs.
 *
 * Recovery chain:
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
    `Failed to parse LLM JSON response. Output length: ${raw.length} chars.\n` +
      `First 300 chars: ${raw.slice(0, 300)}\n` +
      `Last 300 chars: ${raw.slice(-300)}`,
  );
}

/**
 * Parse an LLM response as JSON with truncation recovery (Bible chatJSON
 * pattern, ported word-to-word from atomic-graph-opencode's
 * OpenCodeClient.chatJSON):
 *
 * Recovery chain:
 * 1. Try normal JSON parse with balanced bracket extraction (parseLLMJson)
 * 2. Try truncation recovery (close brackets, recover partial data)
 * 3. If recovery returns partial data, return it (caller decides how to handle)
 * 4. If all recovery fails, throw the original parse error enhanced with context
 */
export function parseLLMJsonWithRecovery<T>(raw: string): T {
  try {
    return parseLLMJson<T>(raw);
  } catch (parseError) {
    // If the response was truncated (common with reasoning models),
    // try to recover what we can rather than failing entirely.
    const recovered = recoverTruncatedJSON<T>(raw);
    if (recovered !== null) {
      console.warn(
        `[jsonParser] Recovered truncated JSON (${raw.length} chars input, recovered keys: ${Object.keys(recovered as object).join(', ')})`,
      );
      return recovered;
    }

    // Enhanced error message with context about why recovery failed
    const errMsg = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(
      `${errMsg}\nRecovery attempted on ${raw.length}-character response but could not extract valid JSON. This usually means the output was truncated mid-structure.`,
    );
  }
}

// ─── Truncated-JSON Recovery Chain (Bible verbatim) ────────────────
// Ported word-to-word from atomic-graph-opencode src/lib/opencodeClient.ts.
// Three attempts, in order:
//   1. closeOpenBrackets           — close what's still open
//   2. truncateToLastCompleteElement — cut back to the last complete {..} / [..]
//   3. recoverFieldsIndividually   — regex-recover known fields one by one

export function recoverTruncatedJSON<T>(raw: string): T | null {
  let cleaned = raw.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const jsonStart = cleaned.search(/\{/);
  if (jsonStart === -1) return null;
  cleaned = cleaned.slice(jsonStart);

  const attempt1 = closeOpenBrackets(cleaned);
  if (attempt1 !== null) {
    return attempt1 as T;
  }

  const attempt2 = truncateToLastCompleteElement(cleaned);
  if (attempt2 !== null) {
    return attempt2 as T;
  }

  const attempt3 = recoverFieldsIndividually(cleaned);
  if (attempt3 !== null) {
    return attempt3 as T;
  }

  return null;
}

function closeOpenBrackets(cleaned: string): Record<string, unknown> | null {
  let curlyDepth = 0, squareDepth = 0;
  let inString = false, escape = false;

  for (const ch of cleaned) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') curlyDepth++;
    else if (ch === '}') curlyDepth--;
    else if (ch === '[') squareDepth++;
    else if (ch === ']') squareDepth--;
  }

  if (curlyDepth === 0 && squareDepth === 0) return null;

  let attempt = findLastSafeTruncation(cleaned);
  if (attempt === null) return null;

  let newCurly = 0, newSquare = 0;
  let inStr = false, esc = false;
  for (const ch of attempt) {
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') newCurly++;
    else if (ch === '}') newCurly--;
    else if (ch === '[') newSquare++;
    else if (ch === ']') newSquare--;
  }

  for (let i = 0; i < newSquare; i++) attempt += ']';
  for (let i = 0; i < newCurly; i++) attempt += '}';

  attempt = attempt.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(attempt) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findLastSafeTruncation(text: string): string | null {
  const stringState: boolean[] = new Array(text.length).fill(false);
  let isStr = false, isEsc = false;
  for (let j = 0; j < text.length; j++) {
    if (isEsc) { isEsc = false; stringState[j] = isStr; continue; }
    if (text[j] === '\\' && isStr) { isEsc = true; stringState[j] = isStr; continue; }
    if (text[j] === '"') isStr = !isStr;
    stringState[j] = isStr;
  }

  const endsInString = stringState[text.length - 1];

  if (endsInString) {
    let stringStartQuote = -1;
    for (let j = text.length - 1; j >= 0; j--) {
      if (text[j] === '"') {
        const stateBefore = j > 0 ? stringState[j - 1] : false;
        const stateAfter = stringState[j];
        if (!stateBefore && stateAfter) {
          stringStartQuote = j;
          break;
        }
      }
    }

    if (stringStartQuote >= 0) {
      let beforeQuote = stringStartQuote - 1;
      while (beforeQuote >= 0 && /\s/.test(text[beforeQuote])) beforeQuote--;

      if (beforeQuote >= 0) {
        const prevChar = text[beforeQuote];
        if (prevChar === ':') {
          let objOpenIdx = -1;
          let depth = 0;
          for (let k = beforeQuote; k >= 0; k--) {
            if (text[k] === '}' && !stringState[k]) depth++;
            else if (text[k] === '{' && !stringState[k]) {
              if (depth === 0) { objOpenIdx = k; break; }
              depth--;
            }
          }
          if (objOpenIdx >= 0) {
            let beforeObj = objOpenIdx - 1;
            while (beforeObj >= 0 && /\s/.test(text[beforeObj])) beforeObj--;
            if (beforeObj >= 0 && text[beforeObj] === ',') {
              return text.slice(0, beforeObj).replace(/,\s*$/, '');
            }
            if (beforeObj >= 0 && text[beforeObj] === '[') {
              return text.slice(0, beforeObj + 1);
            }
            if (beforeObj >= 0 && text[beforeObj] === '{') {
              return text.slice(0, beforeObj + 1);
            }
            return text.slice(0, objOpenIdx).replace(/,\s*$/, '');
          }
          return text.slice(0, beforeQuote).replace(/,\s*$/, '');
        }
        if (prevChar === ',' || prevChar === '[') {
          return text.slice(0, beforeQuote + (prevChar === '[' ? 1 : 0)).replace(/,\s*$/, '');
        }
      }
      return text.slice(0, stringStartQuote).replace(/,\s*$/, '');
    }
  }

  let i = text.length - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return null;

  const ch = text[i];

  if ((ch === '}' || ch === ']') && !stringState[i]) {
    let end = i;
    let k = i - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (k >= 0 && text[k] === ',') end = k;
    return text.slice(0, end + 1).replace(/,\s*$/, '');
  }

  if (ch === '"' && !stringState[i]) {
    let result = text.slice(0, i + 1);
    result = result.replace(/,\s*$/, '');
    return result;
  }

  if (/\d/.test(ch)) {
    const numEnd = i;
    let j = i;
    while (j >= 0 && /[0-9.eE+\-]/.test(text[j])) j--;
    let beforeNum = j;
    while (beforeNum >= 0 && /\s/.test(text[beforeNum])) beforeNum--;
    if (beforeNum >= 0 && (text[beforeNum] === ':' || text[beforeNum] === ',' || text[beforeNum] === '[')) {
      let result = text.slice(0, numEnd + 1);
      result = result.replace(/,\s*$/, '');
      return result;
    }
  }

  for (let j = text.length - 1; j >= 0; j--) {
    if ((text[j] === '}' || text[j] === ']') && !stringState[j]) {
      let result = text.slice(0, j + 1);
      result = result.replace(/,\s*$/, '');
      return result;
    }
  }

  return null;
}

function truncateToLastCompleteElement(cleaned: string): Record<string, unknown> | null {
  const stringState: boolean[] = new Array(cleaned.length).fill(false);
  let isStr = false, isEsc = false;
  for (let j = 0; j < cleaned.length; j++) {
    if (isEsc) { isEsc = false; stringState[j] = isStr; continue; }
    if (cleaned[j] === '\\' && isStr) { isEsc = true; stringState[j] = isStr; continue; }
    if (cleaned[j] === '"') isStr = !isStr;
    stringState[j] = isStr;
  }

  let lastCompleteObjEnd = -1;
  for (let j = cleaned.length - 1; j >= 0; j--) {
    if (cleaned[j] === '}' && !stringState[j]) { lastCompleteObjEnd = j; break; }
  }

  let lastCompleteArrEnd = -1;
  for (let j = cleaned.length - 1; j >= 0; j--) {
    if (cleaned[j] === ']' && !stringState[j]) { lastCompleteArrEnd = j; break; }
  }

  const bestIdx = Math.max(lastCompleteObjEnd, lastCompleteArrEnd);
  if (bestIdx <= 0) return null;

  let truncated = cleaned.slice(0, bestIdx + 1);
  truncated = truncated.replace(/,\s*$/, '');

  let curly = 0, square = 0;
  let inStr = false, esc = false;
  for (const ch of truncated) {
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
  }

  for (let i = 0; i < square; i++) truncated += ']';
  for (let i = 0; i < curly; i++) truncated += '}';
  truncated = truncated.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(truncated) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Field list adapted to the Google Ads activity (Bible recovers graph fields:
// nodes/edges/score/issues/suggestions — here the ads pipeline's own fields).
function recoverFieldsIndividually(cleaned: string): Record<string, unknown> | null {
  try {
    const result: Record<string, unknown> = {};

    const headlinesMatch = cleaned.match(/"headlines"\s*:\s*\[/);
    if (headlinesMatch) {
      const headlinesStart = cleaned.indexOf('[', cleaned.indexOf('"headlines"'));
      const recoveredHeadlines = recoverArrayElements(cleaned, headlinesStart);
      if (recoveredHeadlines && recoveredHeadlines.length > 0) result.headlines = recoveredHeadlines;
    }

    const descriptionsMatch = cleaned.match(/"descriptions"\s*:\s*\[/);
    if (descriptionsMatch) {
      const descriptionsStart = cleaned.indexOf('[', cleaned.indexOf('"descriptions"'));
      const recoveredDescriptions = recoverArrayElements(cleaned, descriptionsStart);
      if (recoveredDescriptions && recoveredDescriptions.length > 0) result.descriptions = recoveredDescriptions;
    }

    const isValidMatch = cleaned.match(/"isValid"\s*:\s*(true|false)/);
    if (isValidMatch) result.isValid = isValidMatch[1] === 'true';

    const qualityScoreMatch = cleaned.match(/"qualityScore"\s*:\s*([\d.]+)/);
    if (qualityScoreMatch) result.qualityScore = parseFloat(qualityScoreMatch[1]);

    const issuesMatch = cleaned.match(/"issues"\s*:\s*\[/);
    if (issuesMatch) {
      const issuesStart = cleaned.indexOf('[', cleaned.indexOf('"issues"'));
      const recoveredIssues = recoverArrayElements(cleaned, issuesStart);
      if (recoveredIssues && recoveredIssues.length > 0) result.issues = recoveredIssues;
    }

    const notesMatch = cleaned.match(/"notes"\s*:\s*"([^"]*)"/);
    if (notesMatch) result.notes = notesMatch[1];

    if (Object.keys(result).length > 0) return result;
  } catch {
    // Recovery failed
  }

  return null;
}

function recoverArrayElements(text: string, arrayStartIndex: number): unknown[] | null {
  if (arrayStartIndex === -1) return null;

  const elements: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escape = false;

  for (let i = arrayStartIndex; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = text.slice(objStart, i + 1);
        try { elements.push(JSON.parse(objStr)); } catch { /* skip */ }
        objStart = -1;
      }
    }
  }

  return elements;
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
      if (depth === 0 && ch === closeCh) {
        return text.slice(startIdx, i + 1);
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
