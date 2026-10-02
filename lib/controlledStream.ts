/**
 * Server-side controlled streaming client.
 *
 * Ports the ax-translator / rag-document-assistant `nvidiaChatStreamControlled`
 * pattern, generalized for any OpenAI-compatible provider (NVIDIA NIM or
 * OpenCode Zen). Used by /api/chat-stream in the Edge runtime.
 *
 * Guarantees (ax-translator pattern):
 *   - Raw fetch + manual SSE reader (no SDK) for maximum control
 *   - Per-call timeout via AbortController (tuned per provider)
 *   - Per-call retry with exponential backoff on transient errors
 *   - 429 rate-limit aware: long sleep + extra backoff, respects Retry-After
 *   - Line-buffered SSE parsing tolerant of partial frames across reads
 *   - Reasoning-as-content fallback when only reasoning_content is returned
 *   - Structured log lines via onLog callback
 *   - Live token chunks via onChunk callback
 *   - Returns full content + reasoning + model + timing metadata
 *
 * All requests use stream:true and accept: text/event-stream.
 */
import { MODELS } from './models';
import type { ChatMessage, ModelId } from './types';

/**
 * Generate a UUID via Web Crypto. The /api/chat-stream route runs on the
 * Edge Runtime, which cannot import 'node:crypto'. `crypto.randomUUID()` is
 * available globally in Edge and Node 19+.
 */
const newSessionId = (): string => crypto.randomUUID();

export interface ControlledStreamOptions {
  modelId: ModelId;
  apiKey: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Per-call timeout in ms. Default = provider timeoutMs from models.ts. */
  timeoutMs?: number;
  /** Max attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Called for every log line. */
  onLog?: (line: string) => void;
  /** Called for every content chunk as it arrives. */
  onChunk?: (text: string, reasoning: boolean) => void;
  /** Optional parent signal to also abort on (e.g. user cancel). */
  signal?: AbortSignal;
}

export interface ControlledStreamResult {
  content: string;
  reasoning: string;
  model: string;
  elapsedMs: number;
  attempts: number;
  /** Number of continuation rounds that were triggered (0 if the model finished in one call). */
  continuations: number;
  /** True if the model exhausted all continuations and is STILL truncated. */
  truncated: boolean;
}

const LOG_TAG = 'stream';

function log(opts: ControlledStreamOptions, msg: string): void {
  const line = `[${LOG_TAG}] ${msg}`;
  // eslint-disable-next-line no-console
  console.log(line);
  opts.onLog?.(line);
}

/**
 * Decide whether an error is worth a retry.
 * Same set as rag-document-assistant's isRetryableError, plus 429.
 */
function isRetryable(status: number, msg: string, errName: string): boolean {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if (errName === 'AbortError') return true;
  const m = msg.toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('econnreset') ||
    m.includes('socket') ||
    m.includes('network')
  );
}

/**
 * Choose a backoff sleep (ms) for retry attempt N (1-based).
 * - 429: prefer Retry-After header (seconds → ms); else 5s, 15s, 30s.
 * - Other retryable: 500ms, 1s, 2s, 4s (exponential).
 */
function backoffMsFor(attempt: number, status: number, retryAfterSec: number | null): number {
  if (status === 429) {
    if (retryAfterSec !== null) return Math.min(retryAfterSec * 1000, 30_000);
    const tiers = [5_000, 15_000, 30_000];
    return tiers[Math.min(attempt - 1, tiers.length - 1)] ?? 30_000;
  }
  // Exponential backoff with cap
  return Math.min(500 * 2 ** (attempt - 1), 8_000);
}

/**
 * Execute one streaming attempt and accumulate content + reasoning.
 * Throws on timeout or HTTP error.
 */
async function streamOnce(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onChunk?: (text: string, reasoning: boolean) => void,
): Promise<{
  content: string;
  reasoning: string;
  ttfbMs: number | null;
  sawDone: boolean;
  /**
   * finish_reason from the model:
   *   'stop'       — model finished naturally (clean stop)
   *   'length'     — model hit max_tokens mid-generation (output truncated)
   *   'content_filter' / 'tool_calls' / undefined — other terminal states
   *
   * We use 'length' to trigger an auto-continue call so the user sees the
   * full output instead of a truncated response.
   */
  finishReason: string | null;
}> {
  const callStart = Date.now();
  // OpenCode Zen requires x-opencode-session for routing — see
  // https://opencode.ai/docs/go/#where-can-i-use-it (enforcement tightened
  // 2026-09-06). NVIDIA NIM does not require this header.
  const isOpenCode = url.includes('opencode.ai');
  const upstreamHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    Accept: 'text/event-stream',
  };
  if (isOpenCode) {
    upstreamHeaders['x-opencode-session'] = newSessionId();
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Upstream ${response.status}: ${errText.slice(0, 300)}`) as Error & {
      status?: number;
      retryAfter?: number | null;
    };
    err.status = response.status;
    const ra = response.headers.get('Retry-After');
    if (ra) {
      const parsed = Number.parseInt(ra, 10);
      err.retryAfter = Number.isFinite(parsed) ? parsed : null;
    }
    throw err;
  }
  if (!response.body) {
    throw new Error('Upstream returned no response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let ttfbMs: number | null = null;
  let sawDone = false;
  let finishReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfbMs === null) ttfbMs = Date.now() - callStart;

    buffer += decoder.decode(value, { stream: true });
    let nlIdx: number;
    while ((nlIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        sawDone = true;
        // Reasoning-as-content fallback: if the model returned only
        // reasoning_content (no content), surface it as content instead
        // of returning empty.
        if (!content && reasoning) {
          content = reasoning;
          onChunk?.(reasoning, false);
        }
        return { content, reasoning, ttfbMs, sawDone, finishReason };
      }
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            onChunk?.(delta.content, false);
          }
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            onChunk?.(delta.reasoning_content, true);
          }
        }
        // Capture finish_reason as soon as it appears. The SSE stream emits
        // it on the final chunk BEFORE [DONE]. We need it to decide whether
        // to auto-continue (see chatCompletionControlled below).
        if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      } catch {
        // Partial JSON across chunks — wait for more bytes.
      }
    }
  }
  // Stream ended without an explicit [DONE]. Apply the same reasoning
  // fallback in case the model finished on a reasoning-only flush.
  if (!content && reasoning) {
    content = reasoning;
    onChunk?.(reasoning, false);
  }
  return { content, reasoning, ttfbMs, sawDone, finishReason };
}

// Generic continuation prompt used when the model returns finish_reason:'length'.
// This does NOT modify the caller's system/user prompts — it's a fixed
// instruction appended only when a continuation round is needed. Works for
// both free-form text AND JSON output: the model sees its partial output
// in the assistant message and continues from exactly where it left off.
const CONTINUE_USER_PROMPT =
  'Continue your previous response from exactly where you left off. Do not repeat any text you have already produced. Do not add any preamble, acknowledgements, or summary — output only the continuation.';

// Max auto-continue rounds when the model returns finish_reason === 'length'.
// Each round re-calls the model with the partial output appended as an
// assistant message, asking it to continue. 3 rounds gives up to 4 total
// calls × max_tokens each of effective output capacity.
const DEFAULT_MAX_CONTINUATIONS = 3;

/**
 * Controlled, logged, time-bounded streaming chat completion with retry
 * + auto-continue on truncation.
 *
 * Returns the full content + reasoning + timing metadata. Throws the final
 * error if all attempts fail.
 *
 * Continue-on-length behavior:
 *   - When the model returns `finish_reason: "length"`, it means the output
 *     was truncated at max_tokens mid-generation. Instead of returning a
 *     truncated response, we automatically send another call with the partial
 *     output appended as an assistant message + a generic "continue from
 *     where you left off" user prompt, then concatenate. The browser sees
 *     continuous streaming with no visible boundary between the original
 *     call and continuation(s). Capped at maxContinuations (default 3).
 *     This is especially important for JSON output (ad copy, validation
 *     results) where truncation produces partial, unparseable JSON.
 */
export async function chatCompletionControlled(
  opts: ControlledStreamOptions,
): Promise<ControlledStreamResult> {
  const config = MODELS[opts.modelId];
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxContinuations = DEFAULT_MAX_CONTINUATIONS;
  const callStart = Date.now();

  log(
    opts,
    `start  provider=${config.id} model=${config.model} max_tokens=${opts.maxTokens ?? config.defaultMaxTokens} temp=${opts.temperature ?? 0.3} timeout=${timeoutMs}ms attempts=${maxAttempts} max_continuations=${maxContinuations}`,
  );

  // Accumulate across the original call + any continuation rounds.
  let fullContent = '';
  let fullReasoning = '';
  let attemptsUsed = 0;
  let continuations = 0;
  let stillTruncated = false;
  let lastErr: Error & { status?: number; retryAfter?: number | null } | null = null;

  // The messages array may grow across continuation rounds: each round
  // appends the assistant's partial output + the generic continue prompt.
  let roundMessages = opts.messages;

  // Loop: original call (round 0) + up to maxContinuations continuation rounds.
  for (let round = 0; round <= maxContinuations; round++) {
    let roundResult: { content: string; reasoning: string; ttfbMs: number | null; sawDone: boolean; finishReason: string | null } | null = null;
    let roundFatal = false;

    // ─── Per-round retry loop (handles transient errors) ───────────
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      // Also abort if parent signal fires (e.g. user cancel)
      let onParentAbort: (() => void) | null = null;
      if (opts.signal) {
        if (opts.signal.aborted) controller.abort(opts.signal.reason);
        else {
          onParentAbort = () => controller.abort(opts.signal!.reason);
          opts.signal.addEventListener('abort', onParentAbort, { once: true });
        }
      }

      try {
        const result = await streamOnce(
          config.baseUrl,
          opts.apiKey,
          {
            model: config.model,
            messages: roundMessages,
            max_tokens: opts.maxTokens ?? config.defaultMaxTokens,
            temperature: opts.temperature ?? 0.3,
            ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
          },
          controller.signal,
          opts.onChunk,
        );
        clearTimeout(timeout);

        attemptsUsed++;
        roundResult = result;

        const elapsed = Date.now() - callStart;
        log(
          opts,
          `round=${round} ttfb=${result.ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${result.content.length} (total=${fullContent.length + result.content.length}) reasoning_chars=${result.reasoning.length} finish_reason=${result.finishReason ?? 'n/a'}`,
        );
        break; // success — exit retry loop, move to continuation check
      } catch (err) {
        clearTimeout(timeout);
        const e = (err ?? new Error('unknown error')) as Error & { status?: number; retryAfter?: number | null };
        const elapsed = Date.now() - callStart;
        lastErr = e;
        const status = e.status ?? 0;
        if (e.name === 'AbortError') {
          log(opts, `TIMEOUT round=${round} attempt=${attempt} after ${timeoutMs}ms (or parent cancel)`);
        } else {
          log(
            opts,
            `ERROR round=${round} attempt=${attempt} after ${elapsed}ms status=${status || 'n/a'}: ${e.name}: ${e.message.slice(0, 200)}`,
          );
        }

        if (attempt >= maxAttempts) { roundFatal = true; break; }
        if (!isRetryable(status, e.message, e.name)) { roundFatal = true; break; }

        const base = backoffMsFor(attempt, status, e.retryAfter ?? null);
        const backoff = Math.round(base * (config.retryBackoffMultiplier ?? 1));
        log(opts, `retry  backing off ${backoff}ms before attempt ${attempt + 1} (status=${status || 'timeout'})`);
        await new Promise((r) => setTimeout(r, backoff));
      } finally {
        if (onParentAbort && opts.signal) {
          opts.signal.removeEventListener('abort', onParentAbort);
        }
      }
    }

    if (!roundResult) {
      // Round failed — if this is round 0, throw the error (no content at all).
      // If we already have partial content from earlier rounds, return it
      // with truncated=true so the caller knows the output is incomplete.
      if (round === 0) {
        const elapsed = Date.now() - callStart;
        const finalErr = lastErr ?? new Error('unknown error');
        throw new Error(
          `Upstream ${config.name} failed after ${maxAttempts} attempts (${elapsed}ms): ${finalErr.name}: ${finalErr.message}`,
        );
      }
      stillTruncated = true;
      log(opts, `TRUNCATED at round ${round} — upstream error after ${continuations} continuation(s)`);
      break;
    }

    // Reasoning-as-content fallback: if the model returned only
    // reasoning_content (no content), surface it as content.
    let roundContent = roundResult.content;
    let roundReasoning = roundResult.reasoning;
    if (!roundContent && roundReasoning) {
      log(opts, `round=${round} empty content — using ${roundReasoning.length} chars of reasoning as content`);
      roundContent = roundReasoning;
      opts.onChunk?.(roundReasoning, false);
    }

    // Accumulate across rounds.
    fullContent += roundContent;
    fullReasoning += roundReasoning;

    if (roundResult.finishReason !== 'length') {
      // Model finished naturally — no continuation needed.
      stillTruncated = false;
      break;
    }

    // finish_reason === 'length' → output was truncated.
    // If we have continuation budget left, append the partial output as
    // an assistant message + the generic continue prompt, and loop again.
    if (round >= maxContinuations || !roundContent) {
      stillTruncated = true;
      log(opts, `TRUNCATED after ${round + 1} round(s) — exhausted maxContinuations=${maxContinuations}. Output ends mid-structure.`);
      break;
    }

    continuations++;
    log(opts, `continue  round=${round + 1}/${maxContinuations} — model hit max_tokens, resuming from char ${fullContent.length}`);

    // Build the next round's messages: original + assistant's partial + continue prompt.
    roundMessages = [
      ...opts.messages,
      { role: 'assistant' as const, content: roundContent },
      { role: 'user' as const, content: CONTINUE_USER_PROMPT },
    ];
  }

  if (!fullContent) {
    const elapsed = Date.now() - callStart;
    const finalErr = lastErr ?? new Error('unknown error');
    throw new Error(
      `Upstream ${config.name} produced no content after ${attemptsUsed} attempt(s) (${elapsed}ms): ${finalErr.name}: ${finalErr.message}`,
    );
  }

  const elapsed = Date.now() - callStart;
  log(
    opts,
    `done   elapsed=${elapsed}ms content_chars=${fullContent.length} reasoning_chars=${fullReasoning.length} attempts=${attemptsUsed} continuations=${continuations} truncated=${stillTruncated}`,
  );

  return {
    content: fullContent,
    reasoning: fullReasoning,
    model: config.model,
    elapsedMs: elapsed,
    attempts: attemptsUsed,
    continuations,
    truncated: stillTruncated,
  };
}
