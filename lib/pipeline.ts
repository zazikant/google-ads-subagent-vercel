/**
 * AX DSPy-style pipeline for Google Ads copy generation.
 *
 * Mirrors the structure of `ax-translator/src/lib/translation-pipeline.ts`
 * pattern-for-pattern — only the specific activity (translation vs ad copy)
 * changes. The DSPy-like scaffolding is identical:
 *
 *   - ErrorEntry tracking — full error history for surgical retries
 *   - compilePrompt() — pure DSPy `Module.compile()` analog, called ONLY
 *     on retries / refinements (never on the initial call)
 *   - isEcho() — detect LLM echoing the input
 *   - resumeFrom state machine: deterministic stage progression
 *   - Activity-style discrete steps:
 *       intent → copy → validate → (if !isValid) refine → revalidate → done
 *   - Validator returns `isValid: boolean` so the orchestrator branches on
 *     validity, not on a numeric threshold (ax-translator's exact shape)
 *   - Validate-after-refine checks `isValid && !isEcho` before exiting
 *   - Stage-specific temperatures + dynamic max_tokens
 *
 * Two modes:
 *   - fast: intent → copy, no validate/refine
 *   - full: full state machine with validate→refine loop (max 2 refinements)
 */

import { chatCompletion } from './llmClient';
import { STAGE_TEMPERATURES, STAGE_MAX_TOKENS, MODELS } from './models';
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

// ─── Inter-stage cooldown (streaming infra, kept) ──────────────────
// NVIDIA's rate-limit window needs time to reset between back-to-back
// LLM calls in the same pipeline. Adaptive based on whether the previous
// stage had to retry. Model-aware via cooldownMultiplier (OpenCode Zen = 0).
export const COOLDOWN_FIRST_SUCCESS_SEC = 3;
export const COOLDOWN_RETRY_SUCCESS_SEC = 10;
export const COOLDOWN_FAILED_SEC = 20;
export const COOLDOWN_RATE_LIMIT_SEC = 30;
export const COOLDOWN_HARD_CAP_SEC = 30;

const RATE_LIMIT_RE = /rate.?limit|429|too many requests/i;

function adaptiveCooldownSec(
  modelId: 'nvidia-gpt-oss-120b' | 'opencode-glm-5.1',
  succeeded: boolean,
  retried: boolean,
  lastErrorMsg = '',
): number {
  const multiplier = MODELS[modelId].cooldownMultiplier ?? 1;
  if (multiplier <= 0) return 0;
  let s: number;
  if (!succeeded) {
    s = RATE_LIMIT_RE.test(lastErrorMsg) ? COOLDOWN_RATE_LIMIT_SEC : COOLDOWN_FAILED_SEC;
  } else if (retried) {
    s = COOLDOWN_RETRY_SUCCESS_SEC;
  } else {
    s = COOLDOWN_FIRST_SUCCESS_SEC;
  }
  s = Math.round(s * multiplier);
  return Math.min(s, COOLDOWN_HARD_CAP_SEC);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function interStageCooldown(
  seconds: number,
  onLog: ((line: string) => void) | undefined,
  nextStage: string,
  signal?: AbortSignal,
): Promise<void> {
  if (seconds <= 0) return;
  onLog?.(`[pipeline] Cooldown: waiting ${seconds}s before ${nextStage} (rate-limit window reset)…`);
  try {
    await sleep(seconds * 1000, signal);
    onLog?.(`[pipeline] Cooldown complete — starting ${nextStage}.`);
  } catch (err) {
    throw err;
  }
}

// Track whether the most recent controlled stream did retries, so
// inter-stage cooldown can be adaptive. Sniffs log lines from controlledStream.
function makeAttemptTracker() {
  let retried = false;
  let lastErrorMsg = '';
  let succeeded = true;
  const onLog = (line: string) => {
    if (/\[stream\]\s+retry\b/.test(line)) retried = true;
    if (/\[stream\]\s+ERROR/.test(line) || /\[stream\]\s+TIMEOUT/.test(line)) {
      succeeded = false;
      lastErrorMsg = line;
    }
    if (/\[stream\]\s+done/.test(line)) {
      succeeded = true;
    }
  };
  return {
    onLog,
    reset: () => {
      retried = false;
      lastErrorMsg = '';
      succeeded = true;
    },
    snapshot: () => ({ retried, succeeded, lastErrorMsg }),
  };
}

// ─── Token Estimation (CJK vs Latin) ───────────────────────────────

function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars / 2 + otherChars / 4);
}

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

// ─── Echo Detection ────────────────────────────────────────────────

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

// ─── compilePrompt — pure function (DSPy Module.compile analog) ───
// Same shape as ax-translator's compileTranslatePrompt. ONLY invoked on
// retries and refinement iterations — never on the initial activity call.
// Produces a focused context string appended to the system prompt that
// reminds the model what failed last time so it doesn't repeat the pattern.

function compilePrompt(
  input: PipelineInput,
  errorHistory: ErrorEntry[],
  stage: 'intent' | 'copy' | 'validate' | 'refine',
): string {
  if (errorHistory.length === 0) {
    return `Initial ${stage} request for Google Ads copy generation`;
  }

  const latestError = errorHistory[errorHistory.length - 1];
  const previousErrors = errorHistory.slice(0, -1).map((e) =>
    `  Attempt ${e.attempt} | ${e.stage}: ${e.error.substring(0, 200)}`,
  ).join('\n');

  const issueContext = latestError.issues && latestError.issues.length > 0
    ? `\nIssues: ${latestError.issues.join(', ')}`
    : '';

  const errorContext = latestError
    ? `\nLatest issue (attempt ${latestError.attempt}, stage ${latestError.stage}): ${latestError.error.substring(0, 300)}${issueContext}`
    : '';

  const previousContext = previousErrors.length > 0
    ? `\nPrevious attempts — do NOT repeat these patterns:\n${previousErrors}`
    : '';

  const productContext = `\nProduct: ${input.product.substring(0, 200)}\nAudience: ${input.audience || 'General'}\nTone: ${input.tone}`;

  return `Refinement context for stage "${stage}":${errorContext}${previousContext}${productContext}`;
}

// ─── System Prompts (one per activity, ax-translator pattern) ─────
// Each prompt is focused on its activity only. The compilePrompt context
// is applied to the SYSTEM prompt only on retries — initial calls keep
// the system prompt as-is. (Mirrors ax-translator's translateActivity.)

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

Evaluate the supplied ad copy and respond in JSON format.

Evaluate on these criteria:
1. Character limits: headlines <= 30, descriptions <= 90
2. Accuracy: no misleading or unverifiable claims
3. Capitalization/punctuation: not excessive
4. Tone-product fit: does the copy match the requested brand tone?
5. Value: does the copy communicate value of the described product?
6. Distinctness: each item is a distinct idea, no near-duplicates

Respond in this exact JSON format:
{
  "isValid": true/false,
  "qualityScore": 0-100,
  "notes": "short summary",
  "issues": ["issue1", "issue2"],
  "fixes": {
    "headline_0": "corrected text",
    "description_1": "corrected text"
  }
}

Set isValid to true if the copy is good enough for production use, even
if minor improvements are possible. Omit the "fixes" key when no fixes
are needed. Be FAIR — don't invent reasons to lower the score.

qualityScore bands:
- 85-100: production-ready
- 70-84: minor issues, easy to fix
- 50-69: significant issues
- below 50: major problems`;

const REFINE_SYSTEM = `You are a Google Ads copy refinement engine.

Fix ALL the issues identified while keeping the rest of the copy unchanged. Output ONLY the improved JSON copy, nothing else.

Hard rules:
- Each headline MUST be <= 30 characters.
- Each description MUST be <= 90 characters.
- You MUST return valid JSON, no markdown, no commentary, no code fences.
- Return the FULL corrected copy (both headlines and descriptions).
- Preserve good copy; only change what needs changing.
- No emojis, no excessive capitalization.

Return ONLY this JSON shape:
{"headlines":["","","","",""],"descriptions":["",""]}`;

// ─── Public entry point ────────────────────────────────────────────

const STAGE_ORDER: ReadonlyArray<StageId> = ['intent', 'copy', 'validate', 'refine'];
const DEFAULT_MAX_REFINEMENTS = 2;

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const mode: PipelineMode = input.mode ?? 'full';
  const maxRefinements = input.maxRefinements ?? DEFAULT_MAX_REFINEMENTS;
  if (mode === 'fast') return runFastPipeline(input);
  return runFullPipeline(input, maxRefinements);
}

// ─── Activity 1: runIntent ────────────────────────────────────────
// Mirrors ax-translator's translateText: isRetry toggles a more forceful
// system prompt; the compilePrompt context is appended only on retries.

type StreamingCb = { onLog?: (line: string) => void; onChunk?: (text: string) => void };

async function runIntent(
  input: PipelineInput,
  isRetry = false,
  retryContext = '',
  streaming?: StreamingCb,
): Promise<string> {
  const baseSystem = isRetry
    ? `${INTENT_SYSTEM}\n\nCRITICAL: You MUST extract value props, intent type, keywords, and a positioning statement. Do NOT echo the product description unchanged.`
    : INTENT_SYSTEM;
  const system = retryContext ? `${baseSystem}\n\n${retryContext}` : baseSystem;

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
    onLog: streaming?.onLog,
    onChunk: streaming?.onChunk ? (text) => streaming.onChunk!(text) : undefined,
  });
  return cleanText(result.content);
}

// ─── Activity 2: runCopy ──────────────────────────────────────────

async function runCopy(
  input: PipelineInput,
  intentText: string,
  isRetry: boolean,
  errorHistory: ErrorEntry[],
  retryContext = '',
  streaming?: StreamingCb,
): Promise<AdCopy> {
  const baseSystem = `${COPY_SYSTEM}${isRetry ? '\n\nCRITICAL: Return ONLY the JSON. No prose, no echo, no commentary.' : ''}`;
  const system = retryContext ? `${baseSystem}\n\n${retryContext}` : baseSystem;

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
    onLog: streaming?.onLog,
    onChunk: streaming?.onChunk ? (text) => streaming.onChunk!(text) : undefined,
  });
  return parseLLMJson<AdCopy>(result.content);
}

// ─── Activity 3: runValidate ──────────────────────────────────────
// Returns isValid + qualityScore, exactly like ax-translator's validator.

async function runValidate(
  input: PipelineInput,
  copy: AdCopy,
  streaming?: StreamingCb,
): Promise<ValidationReport> {
  const messages: ChatMessage[] = [
    { role: 'system', content: VALIDATE_SYSTEM },
    {
      role: 'user',
      content: `Copy: ${JSON.stringify(copy)}\nProduct: ${input.product}\nAudience: ${input.audience || 'General'}\nTone: ${input.tone}`,
    },
  ];

  const result = await chatCompletion(input.modelId, input.apiKey, messages, {
    temperature: STAGE_TEMPERATURES.compliance ?? 0.1,
    maxTokens: STAGE_MAX_TOKENS.compliance,
    signal: input.signal,
    onLog: streaming?.onLog,
    onChunk: streaming?.onChunk ? (text) => streaming.onChunk!(text) : undefined,
  });

  const parsed = parseLLMJson<ValidationReport>(result.content);
  // Tolerate legacy models that returned "score" (0-1) instead of "qualityScore" (0-100).
  const legacyRaw = parsed as unknown as { score?: unknown };
  const legacyScore = typeof legacyRaw.score === 'number'
    ? Math.round(legacyRaw.score * 100)
    : undefined;
  return {
    isValid: parsed.isValid ?? true,
    qualityScore: clamp(parsed.qualityScore ?? legacyScore ?? 70, 0, 100),
    notes: parsed.notes || '',
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    fixes: parsed.fixes && typeof parsed.fixes === 'object' ? parsed.fixes : undefined,
  };
}

// ─── Activity 4: runRefine ────────────────────────────────────────
// Mirrors ax-translator's refineTranslation — only the issues are sent
// in the user content; the compiled retryContext (if any) goes into the
// system prompt as DSPy guidance, not into the user content.

async function runRefine(
  input: PipelineInput,
  copy: AdCopy,
  issues: string[],
  errorHistory: ErrorEntry[],
  isRetry = false,
  retryContext = '',
  streaming?: StreamingCb,
): Promise<AdCopy> {
  const baseSystem = `${REFINE_SYSTEM}${isRetry ? '\n\nCRITICAL: Return ONLY the JSON. No echo of the input copy.' : ''}`;
  const system = retryContext ? `${baseSystem}\n\n${retryContext}` : baseSystem;

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
    onLog: streaming?.onLog,
    onChunk: streaming?.onChunk ? (text) => streaming.onChunk!(text) : undefined,
  });
  return parseLLMJson<AdCopy>(result.content);
}

// ─── runFastPipeline (intent → copy, no validate/refine) ───────────

async function runFastPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const stages: StageLog[] = STAGE_ORDER.map((stage) => ({
    stage,
    status: 'idle' as PhaseStatus,
    text: '',
  }));
  const trace: string[] = ['fast-pipeline'];
  const tracker = makeAttemptTracker();

  setStage(stages, 'intent', 'running', '');
  let intentText: string;
  try {
    intentText = await runIntent(input, false, '', {
      onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
      onChunk: (text) => input.onChunk?.(text, 'intent'),
    });
  } catch (err) {
    return await handleFatal(err, 'intent', 1, stages, trace, [], 'fast');
  }

  // Echo detection — retry once with the forceful prompt (no compilePrompt context).
  if (isEcho(input.product, intentText)) {
    trace.push('echo-detected', 'intent-retry');
    tracker.reset();
    intentText = await runIntent(input, true, '', {
      onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
      onChunk: (text) => input.onChunk?.(text, 'intent'),
    });
  }
  setStage(stages, 'intent', 'done', intentText);
  trace.push('intent');

  // Adaptive inter-stage cooldown.
  const prev = tracker.snapshot();
  if (!prev.succeeded || prev.retried) {
    const cd = adaptiveCooldownSec(input.modelId, prev.succeeded, prev.retried, prev.lastErrorMsg);
    try { await interStageCooldown(cd, input.onLog, 'copy', input.signal); }
    catch (err) { return await handleFatal(err, 'copy', 1, stages, trace, [], 'fast'); }
  }
  tracker.reset();

  setStage(stages, 'copy', 'running', '');
  let copy: AdCopy;
  try {
    copy = await runCopy(input, intentText, false, [], '', {
      onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
      onChunk: (text) => input.onChunk?.(text, 'copy'),
    });
    if (isEcho(input.product, JSON.stringify(copy))) {
      trace.push('echo-detected', 'copy-retry');
      tracker.reset();
      copy = await runCopy(input, intentText, true, [], '', {
        onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
        onChunk: (text) => input.onChunk?.(text, 'copy'),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trace.push('copy-fail');
    return {
      ad: emptyAd(`Copy generation failed: ${msg}`),
      stages,
      pipeline: trace,
      score: 0,
      attempts: 1,
      refinements: 0,
      mode: 'fast',
    };
  }
  const finalCopy = normalizeCopy(copy);
  setStage(stages, 'copy', 'done', `${finalCopy.headlines.length} headlines · ${finalCopy.descriptions.length} descriptions`);
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

// ─── runFullPipeline ──────────────────────────────────────────────
// State machine, same shape as ax-translator's runTranslationPipeline:
//   intent → copy → validate → (if !isValid) refine → revalidate → done
// Branch on isValid (not on a numeric threshold). Validate-after-refine
// requires isValid && !isEcho to exit. Max 2 refinements.

async function runFullPipeline(
  input: PipelineInput,
  maxRefinements: number,
): Promise<PipelineOutput> {
  const stages: StageLog[] = STAGE_ORDER.map((stage) => ({
    stage,
    status: 'idle' as PhaseStatus,
    text: '',
  }));
  const trace: string[] = ['full-pipeline'];
  const tracker = makeAttemptTracker();
  const errorHistory: ErrorEntry[] = [];
  let attempt = 0;
  let refinements = 0;
  let qualityScore = 0;
  let lastNotes = '';
  let currentIssues: string[] = [];
  let copy: AdCopy = { headlines: [], descriptions: [] };

  type Stage = 'intent' | 'copy' | 'validate' | 'refine' | 'done';
  let resumeFrom: Stage = 'intent';

  // ── Stage 1: Intent ────────────────────────────────────────────
  if (resumeFrom === 'intent') {
    attempt++;
    trace.push('intent');
    setStage(stages, 'intent', 'running', '');
    let intentText: string;
    try {
      intentText = await runIntent(input, false, '', {
        onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
        onChunk: (text) => input.onChunk?.(text, 'intent'),
      });
    } catch (err) {
      return await handleFatal(err, 'intent', attempt, stages, trace, errorHistory, 'full');
    }

    // Echo detection on the initial intent call — retry with forceful prompt.
    // If echo persists, validation will catch it.
    if (isEcho(input.product, intentText)) {
      trace.push('echo-detected', 'intent-retry');
      attempt++;
      tracker.reset();
      try {
        intentText = await runIntent(input, true, '', {
          onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
          onChunk: (text) => input.onChunk?.(text, 'intent'),
        });
        if (isEcho(input.product, intentText)) {
          trace.push('echo-persist');
        }
      } catch (err) {
        return await handleFatal(err, 'intent', attempt, stages, trace, errorHistory, 'full');
      }
    }
    setStage(stages, 'intent', 'done', intentText);
    resumeFrom = 'copy';

    // ── Stage 2: Copy ───────────────────────────────────────────
    if (resumeFrom === 'copy') {
      // Adaptive cooldown (only if intent retried/failed).
      const prev = tracker.snapshot();
      if (!prev.succeeded || prev.retried) {
        const cd = adaptiveCooldownSec(input.modelId, prev.succeeded, prev.retried, prev.lastErrorMsg);
        try { await interStageCooldown(cd, input.onLog, 'copy', input.signal); }
        catch (err) { return await handleFatal(err, 'copy', attempt, stages, trace, errorHistory, 'full'); }
      }
      tracker.reset();

      trace.push('copy');
      setStage(stages, 'copy', 'running', '');
      try {
        copy = await runCopy(input, intentText, false, [], '', {
          onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
          onChunk: (text) => input.onChunk?.(text, 'copy'),
        });
        if (isEcho(intentText, JSON.stringify(copy))) {
          trace.push('echo-detected', 'copy-retry');
          attempt++;
          tracker.reset();
          copy = await runCopy(input, intentText, true, [], '', {
            onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
            onChunk: (text) => input.onChunk?.(text, 'copy'),
          });
        }
      } catch (err) {
        // Copy failed entirely — retry once with compilePrompt context (DSPy surgical fix).
        const msg = err instanceof Error ? err.message : String(err);
        errorHistory.push({ attempt, stage: 'copy', error: msg });
        if (attempt < 2) {
          attempt++;
          trace.push('copy-retry');
          const fixContext = compilePrompt(input, errorHistory, 'copy');
          try {
            copy = await runCopy(input, intentText, true, errorHistory, fixContext, {
              onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
              onChunk: (text) => input.onChunk?.(text, 'copy'),
            });
          } catch (err2) {
            const msg2 = err2 instanceof Error ? err2.message : String(err2);
            errorHistory.push({ attempt, stage: 'copy', error: msg2 });
            trace.push('copy-fail');
            return {
              ad: emptyAd(`Copy generation failed after retry: ${msg2}`),
              stages,
              pipeline: trace,
              score: 0,
              attempts: attempt,
              refinements: 0,
              mode: 'full',
            };
          }
        } else {
          trace.push('copy-fail');
          return {
            ad: emptyAd(`Copy generation failed: ${msg}`),
            stages,
            pipeline: trace,
            score: 0,
            attempts: attempt,
            refinements: 0,
            mode: 'full',
          };
        }
      }
      setStage(stages, 'copy', 'done', `${copy.headlines.length} headlines · ${copy.descriptions.length} descriptions`);
      resumeFrom = 'validate';
    }
  }

  // ── Validate → Refine loop ─────────────────────────────────────
  while ((resumeFrom as Stage) !== 'done' && refinements <= maxRefinements) {
    // ── Stage 3: Validate ────────────────────────────────────────
    if (resumeFrom === 'validate') {
      const prev = tracker.snapshot();
      if (prev.retried || !prev.succeeded) {
        const cd = adaptiveCooldownSec(input.modelId, prev.succeeded, prev.retried, prev.lastErrorMsg);
        if (cd > 0) {
          try { await interStageCooldown(cd, input.onLog, 'validate', input.signal); }
          catch {
            errorHistory.push({ attempt, stage: 'validate', error: 'aborted' });
            trace.push('validate-fail');
            qualityScore = 60;
            lastNotes = 'Validation aborted — using estimated score.';
            break;
          }
        }
      }
      tracker.reset();

      trace.push('validate');
      setStage(stages, 'validate', 'running', '');
      let report: ValidationReport;
      try {
        report = await runValidate(input, copy, {
          onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
          onChunk: (text) => input.onChunk?.(text, 'validate'),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errorHistory.push({ attempt, stage: 'validate', error: msg });
        trace.push('validate-fail');
        qualityScore = 60;
        lastNotes = 'Validation step failed — using estimated score.';
        break;
      }

      qualityScore = report.qualityScore;
      currentIssues = report.issues;
      lastNotes = report.notes;

      // If validation caught an echo (copy is identical to source), force refinement.
      const echoCaught = isEcho(input.product, JSON.stringify(copy));
      if (echoCaught) {
        trace.push('echo-caught-by-validation');
        qualityScore = Math.min(qualityScore, 30);
        currentIssues = [...currentIssues, 'Copy appears identical to the product description — not actual ad copy'];
        setStage(stages, 'validate', 'done', `${qualityScore}/100 — echo detected, needs refinement`);
        if (refinements >= maxRefinements) { resumeFrom = 'done'; break; }
        resumeFrom = 'refine';
        continue;
      }

      const passed = report.isValid;
      setStage(stages, 'validate', 'done', `${qualityScore}/100 — ${passed ? 'passed' : 'needs work'}`);

      if (passed) {
        trace.push('validate-pass');
        resumeFrom = 'done';
        break;
      }
      trace.push('validate-fail');
      if (refinements >= maxRefinements) { resumeFrom = 'done'; break; }
      resumeFrom = 'refine';
    }

    // ── Stage 4: Refine ─────────────────────────────────────────
    if (resumeFrom === 'refine') {
      const prev = tracker.snapshot();
      if (prev.retried || !prev.succeeded) {
        const cd = adaptiveCooldownSec(input.modelId, prev.succeeded, prev.retried, prev.lastErrorMsg);
        if (cd > 0) {
          try { await interStageCooldown(cd, input.onLog, 'refine', input.signal); }
          catch {
            errorHistory.push({ attempt, stage: 'refine', error: 'aborted', issues: currentIssues });
            trace.push('refine-fail');
            resumeFrom = 'done';
            break;
          }
        }
      }
      tracker.reset();

      refinements++;
      attempt++;
      trace.push(`refine-${refinements}`);
      setStage(stages, 'refine', 'running', '');

      // Compile surgical fix context (DSPy) — past issues + previous errors.
      const fixContext = compilePrompt(input, errorHistory, 'refine');
      let refined: AdCopy;
      try {
        refined = await runRefine(input, copy, currentIssues, errorHistory, false, fixContext, {
          onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
          onChunk: (text) => input.onChunk?.(text, 'refine'),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errorHistory.push({ attempt, stage: 'refine', error: msg, issues: currentIssues });
        trace.push('refine-fail');
        // Keep current copy and try one more refinement if budget remains.
        if (refinements >= maxRefinements) { resumeFrom = 'done'; break; }
        resumeFrom = 'refine';
        continue;
      }

      // Echo detection on refined output — retry once with forceful prompt.
      if (isEcho(JSON.stringify(copy), JSON.stringify(refined))) {
        trace.push('refine-echo', 'refine-retry');
        attempt++;
        tracker.reset();
        try {
          refined = await runRefine(input, copy, currentIssues, errorHistory, true, fixContext, {
            onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
            onChunk: (text) => input.onChunk?.(text, 'refine'),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errorHistory.push({ attempt, stage: 'refine', error: msg, issues: currentIssues });
          trace.push('refine-fail');
          if (refinements >= maxRefinements) { resumeFrom = 'done'; break; }
          resumeFrom = 'refine';
          continue;
        }
      }
      copy = normalizeCopy(refined);
      setStage(stages, 'refine', 'done', `Refinement #${refinements} complete`);

      // Revalidate (ax-translator's revalidate pattern).
      trace.push(`revalidate-${refinements}`);
      setStage(stages, 'validate', 'running', 'Re-validating after refinement…');
      let revalidation: ValidationReport;
      try {
        revalidation = await runValidate(input, copy, {
          onLog: (line) => { input.onLog?.(line); tracker.onLog(line); },
          onChunk: (text) => input.onChunk?.(text, 'validate'),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errorHistory.push({ attempt, stage: 'validate', error: msg });
        qualityScore = 65;
        lastNotes = `Revalidation failed: ${msg}`;
        trace.push(`revalidate-fail-${refinements}`);
        resumeFrom = 'done';
        break;
      }
      qualityScore = revalidation.qualityScore;
      currentIssues = revalidation.issues;
      lastNotes = revalidation.notes;

      // Pass condition: isValid AND not echoing, exactly like ax-translator.
      const stillEcho = isEcho(input.product, JSON.stringify(copy));
      if (revalidation.isValid && !stillEcho) {
        trace.push(`revalidate-pass-${refinements}`);
        setStage(stages, 'validate', 'done', `${qualityScore}/100 — passed revalidation`);
        resumeFrom = 'done';
        break;
      }
      trace.push(`revalidate-fail-${refinements}`);
      setStage(stages, 'validate', 'done', `${qualityScore}/100 — still needs work`);
      if (refinements >= maxRefinements) { resumeFrom = 'done'; break; }
      // Loop back to validate → refine again.
      resumeFrom = 'validate';
    }
  }

  const ad: AdResult = {
    headlines: copy.headlines,
    descriptions: copy.descriptions,
    compliance: lastNotes || (qualityScore >= 70 ? 'All checks passed.' : 'Issues remain after refinement.'),
  };
  return {
    ad,
    stages,
    pipeline: trace,
    score: qualityScore / 100, // surface as 0-1 for UI consistency
    attempts: attempt,
    refinements,
    mode: 'full',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

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

function emptyAd(compliance: string): AdResult {
  return { headlines: [], descriptions: [], compliance };
}

function clamp(n: number, min: number, max: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

async function handleFatal(
  err: unknown,
  stage: 'intent' | 'copy' | 'validate' | 'refine',
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