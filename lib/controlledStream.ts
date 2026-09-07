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
        return { content, reasoning, ttfbMs, sawDone };
      }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
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
      } catch {
        // Partial JSON across chunks — wait for more bytes.
      }
    }
  }
  return { content, reasoning, ttfbMs, sawDone };
}

/**
 * Controlled, logged, time-bounded streaming chat completion with retry.
 *
 * Returns the full content + reasoning + timing metadata. Throws the final
 * error if all attempts fail.
 */
export async function chatCompletionControlled(
  opts: ControlledStreamOptions,
): Promise<ControlledStreamResult> {
  const config = MODELS[opts.modelId];
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
  const maxAttempts = opts.maxAttempts ?? 3;
  const callStart = Date.now();

  log(
    opts,
    `start  provider=${config.id} model=${config.model} max_tokens=${opts.maxTokens ?? config.defaultMaxTokens} temp=${opts.temperature ?? 0.3} timeout=${timeoutMs}ms attempts=${maxAttempts}`,
  );

  let lastErr: Error & { status?: number; retryAfter?: number | null } | null = null;

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
      const { content, reasoning, ttfbMs, sawDone } = await streamOnce(
        config.baseUrl,
        opts.apiKey,
        {
          model: config.model,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? config.defaultMaxTokens,
          temperature: opts.temperature ?? 0.3,
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        },
        controller.signal,
        opts.onChunk,
      );
      clearTimeout(timeout);

      const elapsed = Date.now() - callStart;
      log(
        opts,
        `ttfb=${ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${content.length} reasoning_chars=${reasoning.length} done_signal=${sawDone}`,
      );

      // Reasoning-as-content fallback (rag-document-assistant pattern):
      // if the model returned only reasoning_content, surface it as content
      // instead of failing the stage.
      let finalContent = content;
      if (!finalContent && reasoning) {
        log(opts, `empty content — using ${reasoning.length} chars of reasoning as content`);
        finalContent = reasoning;
        opts.onChunk?.(reasoning, false);
      }
      if (!finalContent) {
        throw new Error(
          `empty content (reasoning_chars=${reasoning.length}) — finish_reason may be "length", increase max_tokens`,
        ) as Error & { status?: number };
      }

      return { content: finalContent, reasoning, model: config.model, elapsedMs: elapsed, attempts: attempt };
    } catch (err) {
      clearTimeout(timeout);
      const e = (err ?? new Error('unknown error')) as Error & { status?: number; retryAfter?: number | null };
      const elapsed = Date.now() - callStart;
      lastErr = e;
      const status = e.status ?? 0;
      if (e.name === 'AbortError') {
        log(opts, `TIMEOUT attempt=${attempt} after ${timeoutMs}ms (or parent cancel)`);
      } else {
        log(
          opts,
          `ERROR attempt=${attempt} after ${elapsed}ms status=${status || 'n/a'}: ${e.name}: ${e.message.slice(0, 200)}`,
        );
      }

      if (attempt >= maxAttempts) break;
      if (!isRetryable(status, e.message, e.name)) break;

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

  const elapsed = Date.now() - callStart;
  const finalErr = lastErr ?? new Error('unknown error');
  throw new Error(
    `Upstream ${config.name} failed after ${maxAttempts} attempts (${elapsed}ms): ${finalErr.name}: ${finalErr.message}`,
  );
}
