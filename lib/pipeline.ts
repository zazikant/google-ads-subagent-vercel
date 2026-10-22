/**
 * AX DSPy-style pipeline for Google Ads copy generation.
 *
 * Ported word-to-word from the "Bible" repo atomic-graph-opencode
 * (src/lib/axPipeline.ts + src/lib/opencodeClient.ts) — same methodology as
 * the ax-opencode-translator / ax-translator / gsap-animation-pipeline /
 * tradingview-notes-app / Dspy-app ports. The DSPy-like scaffolding is
 * identical to the Bible; only the specific activity (knowledge-graph
 * extraction vs Google Ads copy) changes:
 *
 *   - ErrorEntry tracking — full error history for surgical retries
 *   - callWithRetryAwareness() — rate-limit / transient error detection with
 *     friendly messaging, records to errorHistory (Bible verbatim)
 *   - compileRefinePrompt() — pure DSPy `Module.compile()` analog, called ONLY
 *     on retries / refinements (never on the initial call) — Bible verbatim
 *   - isEcho() — detect LLM echoing the input (Bible verbatim: <10-char guard,
 *     prefix-200 overlap, 0.5 length ratio)
 *   - recoverTruncatedJSON() — 3-layer truncation recovery chain
 *     (closeOpenBrackets → truncateToLastCompleteElement →
 *     recoverFieldsIndividually) via parseLLMJsonWithRecovery — Bible verbatim
 *   - resumeFrom state machine: deterministic stage progression, Bible shape
 *     `while (attempt < maxAttempts && score < threshold && resumeFrom !== 'done')`
 *     with VALIDATION_THRESHOLD = 0.75 (score carried in the Bible's 0-1 domain;
 *     PipelineOutput.score stays 0-1 so the UI contract is unchanged)
 *   - Activity-style discrete steps:
 *       intent → copy → validate → (if score < threshold) refine → revalidate → done
 *   - Stage-specific temperatures + dynamic max_tokens (validate fixed 1024,
 *     floor 2048, cap 8192 — Bible verbatim)
 *
 * Deliberate deviation (documented, same as the other ports): the per-call
 * transport retry stays in controlledStream.ts (3 attempts, 429-aware
 * backoff, provider-tuned) instead of the Bible proxy route's 15s-delay
 * loop — the browser-side SSE transport needs fast backoff to keep the UI
 * responsive. callWithRetryAwareness above it provides the Bible's
 * error-awareness layer.
 *
 * Two modes:
 *   - fast: intent → copy, no validate/refine (Bible runFast: estimated 0.85)
 *   - full: full state machine with validate→refine loop
 */

import { chatCompletion } from './llmClient';
import { STAGE_TEMPERATURES, MODELS } from './models';
import { cleanText, parseLLMJsonWithRecovery } from './jsonParser';
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
  modelId: 'nvidia-gpt-oss-120b' | 'opencode-glm-5.3',
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

export function calculateMaxTokens(
  inputText: string,
  stage: 'intent' | 'copy' | 'validate' | 'refine',
): number {
  // Validation returns small JSON — fixed 1024 is enough (Bible verbatim)
  if (stage === 'validate') return 1024;

  const inputTokens = estimateTokens(inputText);
  // Generation stages (intent/copy ≈ Bible 'extract') produce structured
  // output ≈ 2× input; refine output ≈ 1.5× the copy it is fixing.
  const multiplier = stage === 'intent' || stage === 'copy' ? 2 : 1.5;
  const outputTokens = Math.ceil(inputTokens * multiplier);
  return Math.max(2048, Math.min(8192, outputTokens));
}

// ─── Echo Detection (Bible verbatim) ───────────────────────────────
// Ported word-to-word from atomic-graph-opencode axPipeline.ts isEcho().

export function isEcho(original: string, generated: string): boolean {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  // Check if the generated text is mostly the same as the input
  // (LLM sometimes just echoes input instead of doing the activity)
  const normOrig = normalize(original);
  const normGen = normalize(generated);
  // If the generated text is >80% similar to the input, it's an echo
  if (normGen.length < 10) return false; // Too short to be meaningful
  const overlap = normOrig.includes(normGen.substring(0, Math.min(200, normGen.length)));
  return overlap && normGen.length > normOrig.length * 0.5;
}

// ─── compileRefinePrompt — pure function (DSPy Module.compile analog) ─
// Bible verbatim (atomic-graph-opencode axPipeline.ts compileRefinePrompt).
// Like DSPy's Module.compile() — produces focused prompts based on error
// history. This is the ONLY place refinement prompt construction happens.
// ONLY invoked on retries and refinement iterations — never on the initial
// activity call.

export function compileRefinePrompt(
  issues: string[],
  errorHistory: ErrorEntry[],
  stage: 'intent' | 'copy' | 'validate' | 'refine',
): string {
  // No errors yet — this is initial context
  if (errorHistory.length === 0 && issues.length === 0) {
    return `Initial ${stage} request for Google Ads copy generation`;
  }

  // Build surgical context from error history (Mode B: surgical fix)
  const latestError = errorHistory.length > 0
    ? errorHistory[errorHistory.length - 1]
    : null;
  const previousErrors = errorHistory.slice(0, -1).map(e =>
    `  Attempt ${e.attempt} | ${e.stage}: ${e.error.substring(0, 200)}`
  ).join('\n');

  const issueContext = issues.length > 0
    ? `\nValidation issues to fix:\n${issues.map(i => `  - ${i}`).join('\n')}`
    : '';

  const errorContext = latestError
    ? `\nLatest error (attempt ${latestError.attempt}, stage ${latestError.stage}): ${latestError.error.substring(0, 300)}\n${latestError.issues ? `Issues: ${latestError.issues.join(', ')}` : ''}`
    : '';

  const previousContext = previousErrors.length > 0
    ? `\nPrevious errors — do NOT repeat these patterns:\n${previousErrors}`
    : '';

  return `Refinement context for stage "${stage}":${issueContext}${errorContext}${previousContext}`;
}

// ─── callWithRetryAwareness (Bible verbatim) ───────────────────────
// Wrap an async API call with rate-limit / transient error detection.
// Records errors to errorHistory for DSPy-style compileRefinePrompt().
// Ported word-to-word from atomic-graph-opencode axPipeline.ts
// AXPipeline.callWithRetryAwareness — as a free function here because this
// pipeline is functional, not class-based. Friendly messages surface via
// onLog (the Bible emits them through its iteration callback).

export async function callWithRetryAwareness<T>(
  fn: () => Promise<T>,
  attempt: number,
  phaseLabel: string,
  stage: ErrorEntry['stage'],
  errorHistory: ErrorEntry[],
  onLog?: (line: string) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Track error in history for DSPy-style compiled prompts
    errorHistory.push({
      attempt,
      stage,
      error: msg,
    });

    const isRateLimit =
      msg.includes('rate limit') ||
      msg.includes('Rate limit') ||
      msg.includes('429') ||
      msg.includes('retry attempt') ||
      msg.includes('too many requests');

    const isTransient =
      msg.includes('server error') ||
      msg.includes('Server Error') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('temporary');

    if (isRateLimit) {
      onLog?.(`Rate limited during ${phaseLabel} — all proxy retries exhausted. Please wait and try again.`);
    } else if (isTransient) {
      onLog?.(`Transient server error during ${phaseLabel} — all proxy retries exhausted. Try again shortly.`);
    }

    throw error;
  }
}

// ─── System Prompts (one per activity) ────────────────────────────
// Each prompt is focused on its activity only. The compileRefinePrompt
// context is applied to the SYSTEM prompt only on retries — initial calls
// keep the system prompt as-is.

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

const VALIDATE_SYSTEM = `You are a Google Ads quality reviewer. Evaluate the provided ad copy and respond in JSON format.

Evaluate on these criteria (weight: compliance & accuracy > character limits > tone fit > value clarity > distinctness):
1. COMPLIANCE & ACCURACY: No misleading or unverifiable claims? Google Ads policy safe?
2. CHARACTER LIMITS: Headlines <= 30 chars, descriptions <= 90 chars?
3. TONE FIT: Does the copy match the requested brand tone?
4. VALUE CLARITY: Does the copy communicate the product's value?
5. DISTINCTNESS: Each item a distinct idea, no near-duplicates?

Respond in this exact JSON format:
{
  "isValid": true,
  "qualityScore": 85,
  "notes": "short summary",
  "issues": ["issue1", "issue2"],
  "fixes": {
    "headline_0": "corrected text",
    "description_1": "corrected text"
  }
}

Scoring (qualityScore 0-100):
- 90-100: Production-ready, minor wording differences only
- 75-89: Minor gaps
- 50-74: Significant gaps
- 0-49: Major problems

Set isValid to true if the copy is good enough for production use, even
if minor improvements are possible. Omit the "fixes" key when no fixes
are needed.

Be FAIR — good copy = high score. Don't invent reasons to lower it.
Only list issues affecting COMPLIANCE, LIMITS, or QUALITY.`;

const REFINE_SYSTEM = `You are a Google Ads copy refinement engine. Fix the identified issues while preserving what already works.
Output ONLY the corrected ad copy in JSON, nothing else.

CRITICAL OUTPUT RULES:
- Always respond with valid JSON only. No markdown, no explanation, no code fences.
- Every response must be a single valid JSON object parseable by JSON.parse().
- Preserve good copy wording where accurate — only fix problems the issues list names.
- Headline over 30 characters? SHORTEN it.
- Description over 90 characters? SHORTEN it.
- Misleading or unverifiable claim? Replace it with an accurate one.
- No emojis. No excessive capitalization. No speculative additions.

Return ONLY this JSON shape:
{"headlines":["","","","",""],"descriptions":["",""]}`;

// ─── Public entry point ────────────────────────────────────────────

const STAGE_ORDER: ReadonlyArray<StageId> = ['intent', 'copy', 'validate', 'refine'];
const DEFAULT_MAX_REFINEMENTS = 2;

// Exports below are for smoke-test verification; runtime behavior unchanged.
// Bible verbatim (ax-opencode-translator / ax-translator lineage):
// score below this → refine. The score is carried in the Bible's 0-1 domain
// internally; PipelineOutput.score keeps the same 0-1 domain (UI multiplies
// by 100), so the external contract is unchanged.
export const VALIDATION_THRESHOLD = 0.75;

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const mode: PipelineMode = input.mode ?? 'full';
  const maxRefinements = input.maxRefinements ?? DEFAULT_MAX_REFINEMENTS;
  if (mode === 'fast') return runFastPipeline(input);
  return runFullPipeline(input, maxRefinements);
}

// ─── Activity 1: runIntent ────────────────────────────────────────
// Mirrors the Bible's extract(): isRetry toggles a more forceful
// system prompt; the compileRefinePrompt context is appended only on retries.

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
  return parseLLMJsonWithRecovery<AdCopy>(result.content);
}

// ─── Activity 3: runValidate ──────────────────────────────────────
// Returns isValid + qualityScore (0-100); the state machine compares
// qualityScore/100 against VALIDATION_THRESHOLD — the Bible's exact
// threshold branch (passed = score >= threshold).

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
    maxTokens: calculateMaxTokens('', 'validate'), // Returns 1024 for validate (Bible verbatim)
    signal: input.signal,
    onLog: streaming?.onLog,
    onChunk: streaming?.onChunk ? (text) => streaming.onChunk!(text) : undefined,
  });

  // Bible chatJSON pattern: parseLLMJson first, then truncation recovery.
  const parsed = parseLLMJsonWithRecovery<ValidationReport>(result.content);
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
// Mirrors the Bible's refine() — only the issues are sent
// in the user content; the compiled fixContext (if any) goes into the
// system prompt as DSPy guidance, not into the user content.

async function runRefine(
  input: PipelineInput,
  copy: AdCopy,
  issues: string[],
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
  return parseLLMJsonWithRecovery<AdCopy>(result.content);
}

// ─── runFastPipeline (intent → copy, no validate/refine) ───────────
// Bible runFast pattern: generation stages wrapped in callWithRetryAwareness,
// echo-retry on each, estimated score 0.85 (no validation step).

async function runFastPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const stages: StageLog[] = STAGE_ORDER.map((stage) => ({
    stage,
    status: 'idle' as PhaseStatus,
    text: '',
  }));
  const trace: string[] = ['fast-pipeline'];
  const tracker = makeAttemptTracker();
  const errorHistory: ErrorEntry[] = [];
  const onLogLine = (line: string) => { input.onLog?.(line); tracker.onLog(line); };

  setStage(stages, 'intent', 'running', '');
  let intentText: string;
  try {
    intentText = await callWithRetryAwareness(
      () => runIntent(input, false, '', {
        onLog: onLogLine,
        onChunk: (text) => input.onChunk?.(text, 'intent'),
      }),
      1,
      'Intent',
      'intent',
      errorHistory,
      input.onLog,
    );
  } catch (err) {
    return await handleFatal(err, 'intent', 1, stages, trace, errorHistory, 'fast');
  }

  // Echo detection — retry once with the forceful prompt (no compiled context).
  if (isEcho(input.product, intentText)) {
    trace.push('echo-detected', 'intent-retry');
    tracker.reset();
    try {
      intentText = await runIntent(input, true, '', {
        onLog: onLogLine,
        onChunk: (text) => input.onChunk?.(text, 'intent'),
      });
    } catch {
      // Retry failed, use original result
    }
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
    copy = await callWithRetryAwareness(
      () => runCopy(input, intentText, false, [], '', {
        onLog: onLogLine,
        onChunk: (text) => input.onChunk?.(text, 'copy'),
      }),
      1,
      'Copy',
      'copy',
      errorHistory,
      input.onLog,
    );
    if (isEcho(input.product, JSON.stringify(copy))) {
      trace.push('echo-detected', 'copy-retry');
      tracker.reset();
      try {
        copy = await runCopy(input, intentText, true, [], '', {
          onLog: onLogLine,
          onChunk: (text) => input.onChunk?.(text, 'copy'),
        });
      } catch {
        // Retry failed, use original result
      }
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
// State machine ported word-to-word from the Bible's AXPipeline.run():
//   intent → copy → validate → (if score < threshold) refine → revalidate → done
// KEY FIX carried from the Bible: results are carried FORWARD between
// stages, not re-computed. The loop condition is the Bible's exact shape:
//   while (attempt < maxAttempts && score < threshold && resumeFrom !== 'done')
// VALIDATION_THRESHOLD = 0.75; score is carried in the Bible's 0-1 domain
// (converted from the validator's 0-100 qualityScore at the boundary).
// PipelineOutput.score stays 0-1 — external UI contract unchanged.

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
  const onLogLine = (line: string) => { input.onLog?.(line); tracker.onLog(line); };
  const threshold = input.threshold ?? VALIDATION_THRESHOLD;
  // Bible run(rawNotes, iterations, threshold): attempt 1 is the generation
  // slot and each refine increments attempt, so maxAttempts = maxRefinements+1
  // gives worst case maxRefinements+1 validates + maxRefinements refines
  // (default: 3 validates + 2 refines — Bible MAX_ITERATIONS=3 equivalence).
  const maxAttempts = maxRefinements + 1;
  let attempt = 0;
  let refinements = 0;
  let score = 0; // Bible 0-1 domain
  let lastNotes = '';
  let currentIssues: string[] = [];
  let copy: AdCopy = { headlines: [], descriptions: [] };

  type Stage = 'intent' | 'copy' | 'validate' | 'refine' | 'done';
  let resumeFrom: Stage = 'intent';

  // ── Stage 1: Intent (runs once, result carried forward) ────────
  if (resumeFrom === 'intent') {
    attempt++;
    trace.push('intent');
    setStage(stages, 'intent', 'running', '');
    let intentText: string;
    try {
      intentText = await callWithRetryAwareness(
        () => runIntent(input, false, '', {
          onLog: onLogLine,
          onChunk: (text) => input.onChunk?.(text, 'intent'),
        }),
        attempt,
        'Intent',
        'intent',
        errorHistory,
        input.onLog,
      );

      // Echo detection (Bible verbatim pattern — retry with the forceful
      // prompt at the SAME attempt number; if echo persists, validation
      // and the echo guard will catch it).
      if (isEcho(input.product, intentText)) {
        console.log('[AX Pipeline] Echo detected in intent — retrying with forceful prompt');
        trace.push('echo-detected', 'intent-retry');
        tracker.reset();
        try {
          intentText = await runIntent(input, true, '', {
            onLog: onLogLine,
            onChunk: (text) => input.onChunk?.(text, 'intent'),
          });
          if (isEcho(input.product, intentText)) {
            trace.push('echo-persist');
          }
        } catch {
          // Retry failed, use original result
        }
      }

      resumeFrom = 'copy';
    } catch (err) {
      return await handleFatal(err, 'intent', attempt, stages, trace, errorHistory, 'full');
    }

    // ── Stage 2: Copy (runs once after intent, result carried) ────
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
        copy = await callWithRetryAwareness(
          () => runCopy(input, intentText, false, [], '', {
            onLog: onLogLine,
            onChunk: (text) => input.onChunk?.(text, 'copy'),
          }),
          attempt,
          'Copy',
          'copy',
          errorHistory,
          input.onLog,
        );

        // Echo detection (Bible verbatim pattern — same attempt number).
        if (isEcho(intentText, JSON.stringify(copy))) {
          console.log('[AX Pipeline] Echo detected in copy — retrying with forceful prompt');
          trace.push('echo-detected', 'copy-retry');
          tracker.reset();
          try {
            copy = await runCopy(input, intentText, true, [], '', {
              onLog: onLogLine,
              onChunk: (text) => input.onChunk?.(text, 'copy'),
            });
          } catch {
            // Retry failed, use original result
          }
        }
      } catch (err) {
        if (input.signal?.aborted) {
          return await handleFatal(err, 'copy', attempt, stages, trace, errorHistory, 'full');
        }
        // Copy failed entirely — one DSPy surgical retry with compiled context.
        trace.push('copy-retry');
        const fixContext = compileRefinePrompt([], errorHistory, 'copy');
        try {
          copy = await runCopy(input, intentText, true, errorHistory, fixContext, {
            onLog: onLogLine,
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
      }
      copy = normalizeCopy(copy);
      setStage(stages, 'copy', 'done', `${copy.headlines.length} headlines · ${copy.descriptions.length} descriptions`);
      resumeFrom = 'validate';
    }
  }

  // ─── Validate → Refine loop (Bible verbatim shape, results carried forward) ──
  // This is the Bible's exact loop condition and stage progression.

  while (attempt < maxAttempts && score < threshold && resumeFrom !== 'done') {
    // ── Stage 3: VALIDATE ─────────────────────────────────────────
    if (resumeFrom === 'validate') {
      const prev = tracker.snapshot();
      if (prev.retried || !prev.succeeded) {
        const cd = adaptiveCooldownSec(input.modelId, prev.succeeded, prev.retried, prev.lastErrorMsg);
        if (cd > 0) {
          try { await interStageCooldown(cd, input.onLog, 'validate', input.signal); }
          catch {
            if (input.signal?.aborted) { resumeFrom = 'done'; break; }
            errorHistory.push({ attempt, stage: 'validate', error: 'aborted' });
            trace.push('validate-fail');
            score = 0.7; // Bible fallback
            lastNotes = 'Validation aborted — using estimated score.';
            currentIssues = [lastNotes];
            break;
          }
        }
      }
      tracker.reset();

      // Cosmetic trace distinction only — the state machine itself is the
      // Bible's unified validate stage (revalidate = validate again).
      trace.push(refinements > 0 ? `revalidate-${refinements}` : 'validate');
      setStage(stages, 'validate', 'running', refinements > 0 ? 'Re-validating after refinement…' : '');
      let report: ValidationReport;
      try {
        report = await callWithRetryAwareness(
          () => runValidate(input, copy, {
            onLog: onLogLine,
            onChunk: (text) => input.onChunk?.(text, 'validate'),
          }),
          attempt,
          'Validate',
          'validate',
          errorHistory,
          input.onLog,
        );
      } catch {
        if (input.signal?.aborted) { resumeFrom = 'done'; break; }
        console.warn('[AX Pipeline] Validate failed, using default score');
        trace.push('validate-fail');
        score = 0.7; // Bible fallback
        currentIssues = ['Validation step failed — using estimated score'];
        lastNotes = 'Validation step failed — using estimated score.';
        setStage(stages, 'validate', 'done', `${Math.round(score * 100)}/100 — estimated`);
        // Bible flow: 0.7 < 0.75 → refine if budget allows, else done.
        if (attempt < maxAttempts) {
          resumeFrom = 'refine';
          continue;
        }
        resumeFrom = 'done';
        break;
      }

      // Boundary mapping: validator speaks 0-100, the state machine carries
      // the Bible's 0-1 score domain.
      score = report.qualityScore / 100;
      currentIssues = report.issues;
      lastNotes = report.notes;

      // Echo guard: if validation missed a copy that just echoes the product,
      // force below threshold so the state machine refines
      // (ax-translator lineage: score = Math.min(score, 0.30)).
      if (isEcho(input.product, JSON.stringify(copy))) {
        trace.push('echo-caught-by-validation');
        score = Math.min(score, 0.30);
        currentIssues = [...currentIssues, 'Copy appears identical to the product description — not actual ad copy'];
      }

      // Bible verbatim branch: passed = score >= threshold.
      const passed = score >= threshold;
      setStage(
        stages,
        'validate',
        'done',
        `${Math.round(score * 100)}/100 — ${passed ? (refinements > 0 ? 'passed revalidation' : 'passed') : 'needs work'}`,
      );

      if (passed) {
        trace.push(refinements > 0 ? `revalidate-pass-${refinements}` : 'validate-pass');
        resumeFrom = 'done';
      } else if (attempt < maxAttempts) {
        trace.push('validate-fail');
        resumeFrom = 'refine';
      } else {
        trace.push('validate-fail');
        resumeFrom = 'done';
      }
    }

    // ── Stage 4: REFINE (DSPy-compiled prompt) ────────────────────
    if (resumeFrom === 'refine') {
      const prev = tracker.snapshot();
      if (prev.retried || !prev.succeeded) {
        const cd = adaptiveCooldownSec(input.modelId, prev.succeeded, prev.retried, prev.lastErrorMsg);
        if (cd > 0) {
          try { await interStageCooldown(cd, input.onLog, 'refine', input.signal); }
          catch {
            if (input.signal?.aborted) { resumeFrom = 'done'; break; }
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

      // Compile surgical fix context (DSPy) — Bible verbatim.
      const fixContext = compileRefinePrompt(currentIssues, errorHistory, 'refine');

      let refined: AdCopy;
      try {
        refined = await callWithRetryAwareness(
          () => runRefine(input, copy, currentIssues, false, fixContext, {
            onLog: onLogLine,
            onChunk: (text) => input.onChunk?.(text, 'refine'),
          }),
          attempt,
          'Refine',
          'refine',
          errorHistory,
          input.onLog,
        );
      } catch {
        if (input.signal?.aborted) { resumeFrom = 'done'; break; }
        console.warn('[AX Pipeline] Refine failed, keeping current result');
        trace.push('refine-fail');
        // Keep current result, loop back to validate (Bible verbatim).
        resumeFrom = 'validate';
        continue;
      }

      // Echo detection on refined output — retry once with forceful prompt
      // (Bible verbatim pattern — same attempt number).
      if (isEcho(JSON.stringify(copy), JSON.stringify(refined))) {
        console.log('[AX Pipeline] Echo detected in refine — retrying with forceful prompt');
        trace.push('refine-echo', 'refine-retry');
        tracker.reset();
        try {
          refined = await runRefine(input, copy, currentIssues, true, fixContext, {
            onLog: onLogLine,
            onChunk: (text) => input.onChunk?.(text, 'refine'),
          });
        } catch {
          // Retry failed, use original refined result
        }
      }

      copy = normalizeCopy(refined);
      setStage(stages, 'refine', 'done', `Refinement #${refinements} complete`);

      // After refine, loop back to validate (Bible verbatim).
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
    score, // already 0-1 — UI contract unchanged
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