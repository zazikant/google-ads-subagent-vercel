/**
 * Send a chat completion to an OpenAI-compatible endpoint via streaming.
 *
 * Calls the same-origin Next.js route at `/api/chat-stream` (Edge, SSE),
 * which forwards the request to NVIDIA NIM / OpenCode Zen with stream:true
 * and handles per-call retries, exponential backoff, 429 rate-limit
 * cooldowns, and a reasoning-as-content fallback (see controlledStream.ts).
 *
 * The fetch consumer here parses the SSE stream, forwards structured log
 * lines and live token chunks to the caller via `onLog` / `onChunk`, then
 * returns the final aggregated `ChatResponse` exactly like the legacy
 * non-streaming client — so call sites that don't care about live updates
 * keep working unchanged.
 *
 * Per-model settings (URL, model name, timeout, max tokens, reasoning
 * effort) live in `lib/models.ts`.
 */
import { MODELS } from './models';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ModelId,
} from './types';

export async function chatCompletion(
  modelId: ModelId,
  apiKey: string,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResponse> {
  const config = MODELS[modelId];
  const controller = new AbortController();
  const linked = linkSignals(controller, options.signal);
  const timeoutMs = config.timeoutMs;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 10_000);

  let response: Response;
  try {
    response = await fetch('/api/chat-stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        maxTokens: options.maxTokens,
        temperature: options.temperature ?? 0.3,
        reasoningEffort: config.reasoningEffort,
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    linked.dispose();
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `${config.name} request aborted (timed out after ${Math.round(timeoutMs / 1000)}s or user cancelled)`,
        { cause: err },
      );
    }
    throw err;
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeoutId);
    linked.dispose();
    throw await toProxyError(response);
  }

  // Parse the SSE stream.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let model = config.model;
  let usage: ChatResponse['usage'] | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue; // partial frame; wait for more bytes
        }

        const type = event.type as string | undefined;
        if (type === 'log') {
          if (typeof event.line === 'string') options.onLog?.(event.line);
        } else if (type === 'chunk') {
          if (typeof event.text === 'string' && event.text) {
            const isReasoning = event.reasoning === true;
            if (isReasoning) {
              reasoning += event.text;
            } else {
              content += event.text;
            }
            options.onChunk?.(event.text, isReasoning);
          }
        } else if (type === 'done') {
          if (typeof event.content === 'string') content = event.content || content;
          if (typeof event.reasoning === 'string') reasoning = event.reasoning;
          if (typeof event.model === 'string') model = event.model;
          if (event.usage && typeof event.usage === 'object') {
            const u = event.usage as Record<string, unknown>;
            usage = {
              prompt_tokens: Number(u.prompt_tokens ?? 0),
              completion_tokens: Number(u.completion_tokens ?? 0),
              total_tokens: Number(u.total_tokens ?? 0),
            };
          }
        } else if (type === 'error') {
          const msg = typeof event.message === 'string' ? event.message : 'Upstream server error';
          throw new Error(msg);
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `${config.name} stream aborted (timed out after ${Math.round(timeoutMs / 1000)}s or user cancelled)`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    linked.dispose();
  }

  // Reasoning-as-content fallback handled server-side, so content should
  // always be non-empty by the time we get a `done`. Guard regardless.
  const finalContent = content || reasoning;
  if (!finalContent) {
    throw new Error(
      `${config.name} returned an empty response (both content and reasoning_content are null). ` +
        'This usually means the model spent the whole token budget on internal reasoning.',
    );
  }

  return {
    content: finalContent,
    model,
    usage,
  };
}

async function toProxyError(response: Response): Promise<Error> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string; detail?: string };
      detail = parsed.error?.message || parsed.message || parsed.detail || text;
    } catch {
      detail = text;
    }
  } catch {
    // ignore
  }

  if (response.status === 401) {
    return new Error(`Invalid or missing API key. ${detail || 'Check the key in the config bar.'}`);
  }
  if (response.status === 403) {
    return new Error(`Access denied. ${detail || 'Your key may not be allowed for this model.'}`);
  }
  if (response.status === 404) {
    return new Error(`Model not found. ${detail || 'It may have been renamed or retired.'}`);
  }
  if (response.status === 429) {
    return new Error(`Rate limited. ${detail || 'Wait a moment and try again.'}`);
  }
  if (response.status >= 500) {
    return new Error(`Server error (${response.status}): ${detail || 'no body'}. Usually temporary.`);
  }
  return new Error(`API error (${response.status}): ${detail || 'no body'}`);
}

interface LinkedSignals {
  readonly dispose: () => void;
}

function linkSignals(controller: AbortController, parent?: AbortSignal): LinkedSignals {
  if (!parent) {
    return { dispose: () => undefined };
  }
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { dispose: () => undefined };
  }
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return {
    dispose: () => parent.removeEventListener('abort', onAbort),
  };
}