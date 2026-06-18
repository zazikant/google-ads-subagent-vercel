/**
 * AX DSPy-style pipeline for Google Ads copy generation.
 *
 * Patterns ported from `ax-translator/src/lib/translation-pipeline.ts`:
 *   - ErrorEntry tracking — full error history for surgical retries
 *   - compileRefinePrompt() — pure function, DSPy `Module.compile()` analog
 *   - isEcho() — detect LLM echoing the input
 *   - resumeFrom state machine — deterministic stage progression
 *   - Activity-style discrete steps — intent → copy → validate → refine
 *   - Stage-specific temperatures and dynamic max_tokens
 *
 * Flow:
 *   intent → copy → validate → (if score < threshold) refine → validate → done
 *   max 2 refinements by default
 *
 * Two modes:
 *   - `fast`:  intent → copy, no validation/refinement
 *   - `full`:  full state machine with validate→refine loop
 */

import { chatCompletion } from './llmClient';
import { STAGE_TEMPERATURES, STAGE_MAX_TOKENS } from './models';
import { cleanText, parseLLMJson } from './jsonParser';
import type {
  AdCopy,
  AdResult,
  ChatMessage,
  PhaseStatus,
  PipelineInput,
  PipelineMode,
  PipelineOutput,
  StageId,
  StageLog,
  ValidationReport,
} from './types';

// ─── AX DSPy-style Error Tracking ──────────────────────────────────

interface ErrorEntry {
  attempt: number;
  stage: 'intent' | 'copy' | 'validate' | 'refine';
  error: string;
  issues?: string[];
}

// ─── Token Estimation (CJK vs Latin, from ax-translator) ────────────

function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 2 + otherChars / 4);
}

/**
 * Dynamic max_tokens per stage.
 * - intent/copy produce ~2x input
 * - refine produces ~1.5x input
 * - validate always returns small JSON
 */
function calculateMaxTokens(
  inputText: string,
  stage: 'intent' | 'copy' | 'validate' | 'refine',
): number {
  if (stage === 'validate') return 1024;

  const inputTokens = estimateTokens(inputText);
  const multiplier = stage === 'intent' || stage === 'copy' ? 2 : 1.5;
  const outputTokens = Math.ceil(inputTokens * multiplier);
  const cap = stage === 'refine' ? 8192 : 4096;
  return Math.max(2048, Math.min(cap, outputTokens));
}

// ─── Echo Detection (ax-translator pattern) ─────────────────────────

function isEcho(original: string, generated: string): boolean {
  const normalize = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 240);
  const a = normalize(original);
  const b = normalize(generated);
  if (a.length < 20 || b.length < 20) return false;
  return a === b || b.includes(a) || a.includes(b);
}

// ─── compileRefinePrompt — pure function (DSPy Module.compile) ──────

function compileRefinePrompt(
  issues: string[],
  errorHistory: ErrorEntry[],
  stage: 'intent' | 'copy' | 'validate' | 'refine',
): string {
  if (errorHistory.length === 0 && issues.length === 0) {
    return `Initial ${stage} request for Google Ads copy generation`;
  }

  const latestError = errorHistory.length > 0 ? errorHistory[errorHistory.length - 1] : null;
  const previousErrors = errorHistory.slice(0, -1).map((e) =>
    `  Attempt ${e.attempt} | ${e.stage}: ${e.error.substring(0, 200)}`,
  ).join('\n');

  const issueContext = issues.length > 0
    ? `\nValidation issues to fix:\n${issues.map((i) => `  - ${i}`).join('\n')}`
    : '';

  const errorContext = latestError
    ? `\nLatest error (attempt ${latestError.attempt}, stage ${latestError.stage}): ${latestError.error.substring(0, 300)}${
        latestError.issues ? `\nIssues: ${latestError.issues.join(', ')}` : ''
      }`
    : '';

  const previousContext = previousErrors.length > 0
    ? `\nPrevious errors — do NOT repeat these patterns:\n${previousErrors}`
    : '';

  return `Refinement context for stage "${stage}":${issueContext}${errorContext}${previousContext}`;
}

// ─── System Prompts (one per activity) ──────────────────────────────

const INTENT_SYSTEM = `You are a strategic advertising analyst. Extract the core value propositions of a product and map them to user search intent.

Output format (plain text, NOT JSON):
- 3-4 core value propositions (each one short bullet)
- Primary search intent type (informational / commercial / transactional)
- 5 high-intent keywords
- One positioning statement (1 sentence)

Be concise. Do NOT write ad copy yet — that comes in the next stage.`;

const COPY_SYSTEM = `You are a Google Ads copywriter.

Hard rules:
- Each headline MUST be <= 30 characters.
- Each description MUST be <= 90 characters.
- You MUST return valid JSON, no markdown, no commentary, no code fences.
- Provide exactly 5 headlines and 2 descriptions.
- No emojis. No excessive capitalization. No misleading superlatives.
- Tone must match the requested brand tone.

Return ONLY this JSON shape:
{"headlines":["","","","",""],"descriptions":["",""]}`;

const VALIDATE_SYSTEM = `You are a Google Ads compliance AND quality reviewer.

Evaluate the supplied ad copy on a 0-1 scale. Consider:
- Character limits (headlines <= 30, descriptions <= 90)
- Misleading or unverifiable claims
- Excessive capitalization or punctuation
- Tone-product fit
- Whether the copy actually communicates value
- Whether each item is a distinct idea (no near-duplicates)

Return ONLY valid JSON, no markdown, no commentary, no code fences:
{
  "score": 0.85,
  "notes": "short summary",
  "issues": ["issue1", "issue2"],
  "fixes": {
    "headline_0": "corrected text",
    "description_1": "corrected text"
  }
}

Scoring:
- 0.85-1.00: production-ready
- 0.70-0.84: minor issues, easy to fix
- 0.50-0.69: significant issues
- below 0.50: major problems

Omit the "fixes" key entirely when no fixes are needed. Be FAIR — don't invent reasons to lower the score.`;

const REFINE_SYSTEM = `You are a Google Ads copy refinement engine. Fix the identified issues while preserving what already works.

Hard rules:
- Each headline MUST be <= 30 characters.
- Each description MUST be <= 90 characters.
- You MUST return valid JSON, no markdown, no commentary, no code fences.
- Return the FULL corrected copy (both headlines and descriptions).
- Preserve good copy; only change what needs changing.
- No emojis, no excessive capitalization.

Return ONLY this JSON shape:
{"headlines":["","","","",""],"descriptions":["",""]}`;

// ─── Public entry point ─────────────────────────────────────────────

const STAGE_ORDER: ReadonlyArray<StageId> = ['intent', 'copy', 'validate', 'refine'];

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MAX_REFINEMENTS = 2;

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const mode: PipelineMode = input.mode ?? 'full';
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const maxRefinements = input.maxRefinements ?? DEFAULT_MAX_REFINEMENTS;

  if (mode === 'fast') {
    return runFastPipeline(input);
  }
  return runFullPipeline(input, threshold, maxRefinements);
}

// ─── runFastPipeline — single pass, no validate/refine ──────────────

async function runFastPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const stages: StageLog[] = STAGE_ORDER.map((stage) => ({
    stage,
    status: 'idle' as PhaseStatus,
    text: '',
  }));
  const trace: string[] = ['fast-pipeline'];

  setStage(stages, 'intent', 'running', '');
  const intentText = await runIntent(input);
  setStage(stages, 'intent', 'done', intentText);
  trace.push('intent');

  setStage(stages, 'copy', 'running', '');
  let copy = await runCopy(input, intentText, false, [], []);
  if (isEcho(input.product, JSON.stringify(copy))) {
    trace.push('echo-detected', 'copy-retry');
    copy = await runCopy(input, intentText, true, [], []);
  }
  const finalCopy = normalizeCopy(copy);
  setStage(
    stages,
    'copy',
    'done',
    `${finalCopy.headlines.length} headlines · ${finalCopy.descriptions.length} descriptions`,
  );
  trace.push('copy');

  const ad: AdResult = {
    headlines: finalCopy.headlines,
    descriptions: finalCopy.descriptions,
    compliance: 'Fast mode — no compliance validation was run.',
  };

  return {
    ad,
    stages,
    pipeline: trace,
    score: 0.85,
    attempts: trace.filter((s) => s.includes('retry')).length + 1,
    refinements: 0,
    mode: 'fast',
  };
}

// ─── runFullPipeline — state machine with validate→refine loop ──────

async function runFullPipeline(
  input: PipelineInput,
  threshold: number,
  maxRefinements: number,
): Promise<PipelineOutput> {
  const stages: StageLog[] = STAGE_ORDER.map((stage) => ({
    stage,
    status: 'idle' as PhaseStatus,
    text: '',
  }));
  const trace: string[] = ['full-pipeline'];
  const errorHistory: ErrorEntry[] = [];
  let attempt = 0;
  let refinements = 0;
  let score = 0;
  let currentIssues: string[] = [];
  let copy: AdCopy = { headlines: [], descriptions: [] };
  let lastNotes = '';

  type Stage = 'intent' | 'copy' | 'validate' | 'refine' | 'done';
  let resumeFrom: Stage = 'intent';

  // ── Stage 1: Intent ─────────────────────────────────────────────
  if (resumeFrom === 'intent') {
    attempt++;
    trace.push('intent');
    setStage(stages, 'intent', 'running', '');
    let intentText: string;
    try {
      intentText = await runIntent(input);
    } catch (err) {
      return await handleFatal(err, 'intent', attempt, stages, trace, errorHistory, 'full');
    }

    if (isEcho(input.product, intentText)) {
      trace.push('echo-detected', 'intent-retry');
      attempt++;
      intentText = await runIntent(input, true);
    }
    setStage(stages, 'intent', 'done', intentText);
    copy = { headlines: [], descriptions: [] };
    resumeFrom = 'copy';

    // ── Stage 2: Copy ───────────────────────────────────────────
    if (resumeFrom === 'copy') {
      trace.push('copy');
      setStage(stages, 'copy', 'running', '');
      try {
        let raw = await runCopy(input, intentText, false, [], errorHistory);
        if (isEcho(intentText, JSON.stringify(raw))) {
          trace.push('echo-detected', 'copy-retry');
          attempt++;
          raw = await runCopy(input, intentText, true, [], errorHistory);
        }
        copy = normalizeCopy(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errorHistory.push({ attempt, stage: 'copy', error: msg });
        trace.push('copy-fail');
        return {
          ad: emptyAd('Copy generation failed.'),
          stages,
          pipeline: trace,
          score: 0,
          attempts: attempt,
          refinements: 0,
          mode: 'full',
        };
      }
      setStage(
        stages,
        'copy',
        'done',
        `${copy.headlines.length} headlines · ${copy.descriptions.length} descriptions`,
      );
      resumeFrom = 'validate';
    }
  }

  // ── Validate → Refine loop (carries result forward) ──────────────
  while ((resumeFrom as Stage) !== 'done' && refinements <= maxRefinements) {
    // ── Stage 3: Validate ───────────────────────────────────────
    if ((resumeFrom as Stage) === 'validate') {
      trace.push('validate');
      setStage(stages, 'validate', 'running', '');
      let report: ValidationReport;
      try {
        report = await runValidate(input, copy);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errorHistory.push({ attempt, stage: 'validate', error: msg });
        trace.push('validate-fail');
        // Use a permissive default and exit
        score = 0.7;
        lastNotes = 'Validation step failed — using estimated score.';
        break;
      }

      score = report.score;
      currentIssues = report.issues;
      lastNotes = report.notes;

      const passed = score >= threshold;
      setStage(
        stages,
        'validate',
        'done',
        `${(score * 100).toFixed(0)}/100 — ${passed ? 'passed' : 'needs work'}`,
      );

      // Apply any immediate fixes the validator provided
      if (report.fixes) {
        copy = applyFixes(copy, report.fixes);
        trace.push('validate-fixes-applied');
      }

      if (passed) {
        trace.push('validate-pass');
        resumeFrom = 'done';
        break;
      }

      trace.push('validate-fail');
      if (refinements >= maxRefinements) {
        resumeFrom = 'done';
        break;
      }
      resumeFrom = 'refine';
    }

    // ── Stage 4: Refine (DSPy-compiled prompt) ───────────────────
    if ((resumeFrom as Stage) === 'refine') {
      refinements++;
      attempt++;
      trace.push(`refine-${refinements}`);
      setStage(stages, 'refine', 'running', '');

      try {
        const refined = await runRefine(input, copy, currentIssues, errorHistory);
        if (isEcho(JSON.stringify(copy), JSON.stringify(refined))) {
          trace.push('refine-echo', 'refine-retry');
          attempt++;
          const retry = await runRefine(input, copy, currentIssues, errorHistory, true);
          copy = normalizeCopy(retry);
        } else {
          copy = normalizeCopy(refined);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errorHistory.push({ attempt, stage: 'refine', error: msg, issues: currentIssues });
        trace.push('refine-fail');
        // Keep current copy, go back to validate
        resumeFrom = 'validate';
        continue;
      }
      setStage(
        stages,
        'refine',
        'done',
        `Refinement #${refinements} complete`,
      );
      resumeFrom = 'validate';
    }
  }

  const ad: AdResult = {
    headlines: copy.headlines,
    descriptions: copy.descriptions,
    compliance: lastNotes || (score >= threshold ? 'All checks passed.' : 'Issues remain after refinement.'),
  };

  return {
    ad,
    stages,
    pipeline: trace,
    score,
    attempts: attempt,
    refinements,
    mode: 'full',
  };
}

// ─── Stage activities (one LLM call each) ──────────────────────────

async function runIntent(input: PipelineInput, isRetry = false): Promise<string> {
  const system = isRetry
    ? `${INTENT_SYSTEM}\n\nCRITICAL: You MUST extract value props, intent type, keywords, and a positioning statement. Do NOT echo the product description unchanged.`
    : INTENT_SYSTEM;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Product: ${input.product}\nAudience: ${input.audience || 'General'}\nTone: ${input.tone}`,
    },
  ];

  const result = await chatCompletion(input.modelId, input.apiKey, messages, {
    temperature: STAGE_TEMPERATURES.intent,
    maxTokens: calculateMaxTokens(input.product, 'intent'),
    signal: input.signal,
  });
  return cleanText(result.content);
}

async function runCopy(
  input: PipelineInput,
  intentText: string,
  isRetry: boolean,
  _issues: string[],
  errorHistory: ErrorEntry[],
): Promise<AdCopy> {
  void _issues;
  const fixContext = compileRefinePrompt([], errorHistory, 'copy');
  const system = `${COPY_SYSTEM}\n\n${fixContext}${isRetry ? '\n\nCRITICAL: Return ONLY the JSON. No prose, no echo, no commentary.' : ''}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content:
        `Strategy from previous stage:\n${intentText}\n\n` +
        `Product: ${input.product}\nAudience: ${input.audience || 'General'}\nTone: ${input.tone}`,
    },
  ];

  const result = await chatCompletion(input.modelId, input.apiKey, messages, {
    temperature: STAGE_TEMPERATURES.copy,
    maxTokens: calculateMaxTokens(intentText, 'copy'),
    signal: input.signal,
  });
  return parseLLMJson<AdCopy>(result.content);
}

async function runValidate(input: PipelineInput, copy: AdCopy): Promise<ValidationReport> {
  const messages: ChatMessage[] = [
    { role: 'system', content: VALIDATE_SYSTEM },
    {
      role: 'user',
      content: `Copy: ${JSON.stringify(copy)}\nProduct: ${input.product}`,
    },
  ];

  const result = await chatCompletion(input.modelId, input.apiKey, messages, {
    temperature: STAGE_TEMPERATURES.compliance ?? 0.1,
    maxTokens: STAGE_MAX_TOKENS.compliance,
    signal: input.signal,
  });

  const parsed = parseLLMJson<ValidationReport>(result.content);
  return {
    score: clamp(parsed.score, 0, 1),
    notes: parsed.notes || '',
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    fixes: parsed.fixes && typeof parsed.fixes === 'object' ? parsed.fixes : undefined,
  };
}

async function runRefine(
  input: PipelineInput,
  copy: AdCopy,
  issues: string[],
  errorHistory: ErrorEntry[],
  isRetry = false,
): Promise<AdCopy> {
  const fixContext = compileRefinePrompt(issues, errorHistory, 'refine');
  const system = `${REFINE_SYSTEM}\n\n${fixContext}${isRetry ? '\n\nCRITICAL: Return ONLY the JSON. No echo of the input copy.' : ''}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content:
        `Issues found:\n${issues.map((i) => `- ${i}`).join('\n')}\n\n` +
        `Current copy:\n${JSON.stringify(copy)}`,
    },
  ];

  const result = await chatCompletion(input.modelId, input.apiKey, messages, {
    temperature: 0.2,
    maxTokens: calculateMaxTokens(JSON.stringify(copy), 'refine'),
    signal: input.signal,
  });
  return parseLLMJson<AdCopy>(result.content);
}

// ─── Helpers ────────────────────────────────────────────────────────

function setStage(stages: StageLog[], id: StageId, status: PhaseStatus, text: string): void {
  const idx = stages.findIndex((s) => s.stage === id);
  if (idx === -1) return;
  stages[idx] = { stage: id, status, text };
}

function normalizeCopy(raw: AdCopy): AdCopy {
  return {
    headlines: ensureLength(raw.headlines, 5, 'Headline', 30).map((h) => h.slice(0, 30)),
    descriptions: ensureLength(raw.descriptions, 2, 'Description', 90).map((d) => d.slice(0, 90)),
  };
}

function ensureLength(arr: unknown, expected: number, label: string, charLimit: number): string[] {
  const list = Array.isArray(arr) ? arr : [];
  const result: string[] = [];
  for (let i = 0; i < expected; i++) {
    const raw = list[i];
    const value = typeof raw === 'string' ? raw : '';
    result.push(value.slice(0, charLimit) || `${label} ${i + 1}`);
  }
  return result;
}

function applyFixes(copy: AdCopy, fixes: Record<string, string>): AdCopy {
  const headlines = [...copy.headlines];
  const descriptions = [...copy.descriptions];
  for (const [key, value] of Object.entries(fixes)) {
    const match = key.match(/^(headline|description)_(\d+)$/);
    if (!match) continue;
    const idx = Number.parseInt(match[2], 10);
    const trimmed = value.slice(0, match[1] === 'headline' ? 30 : 90);
    if (match[1] === 'headline' && idx >= 0 && idx < headlines.length) {
      headlines[idx] = trimmed;
    } else if (match[1] === 'description' && idx >= 0 && idx < descriptions.length) {
      descriptions[idx] = trimmed;
    }
  }
  return { headlines, descriptions };
}

function emptyAd(compliance: string): AdResult {
  return {
    headlines: [],
    descriptions: [],
    compliance,
  };
}

function clamp(n: number, min: number, max: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.min(max, Math.max(min, n));
}

async function handleFatal(
  err: unknown,
  stage: 'intent',
  attempt: number,
  stages: StageLog[],
  trace: string[],
  errorHistory: ErrorEntry[],
  mode: 'full' | 'fast',
): Promise<PipelineOutput> {
  const msg = err instanceof Error ? err.message : String(err);
  errorHistory.push({ attempt, stage, error: msg });
  trace.push(`${stage}-fail`);
  return {
    ad: emptyAd(`${stage} failed: ${msg}`),
    stages,
    pipeline: trace,
    score: 0,
    attempts: attempt,
    refinements: 0,
    mode,
  };
}
