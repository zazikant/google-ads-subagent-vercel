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
 *   - Activity-style discrete steps:
 *       intent → copy — single direct pass (no validate/refine stage)
 *   - Stage-specific temperatures + dynamic max_tokens (floor 2048, cap 8192
 *     — Bible verbatim)
 *
 * Deliberate deviation (documented, same as the other ports): the per-call
 * transport retry stays in controlledStream.ts (3 attempts, 429-aware
 * backoff, provider-tuned) instead of the Bible proxy route's 15s-delay
 * loop — the browser-side SSE transport needs fast backoff to keep the UI
 * responsive. callWithRetryAwareness above it provides the Bible's
 * error-awareness layer.
 *
 * Single mode (validate stage removed, as in ax-translator):
 *   - intent → copy, no validate/refine (Bible runFast: estimated 0.85)
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
  PipelineOutput,
  StageId,
  StageLog,
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

// ─── Public entry point ────────────────────────────────────────────

const STAGE_ORDER: ReadonlyArray<StageId> = ['intent', 'copy'];

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  // Single direct pass: intent → copy. No validate/refine stage — every
  // run streams straight through and the score is the Bible's estimated
  // 0.85 (no validation step).
  return runFastPipeline(input);
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