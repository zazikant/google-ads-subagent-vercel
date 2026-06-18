/**
 * Send a chat completion to an OpenAI-compatible endpoint.
 *
 * The browser can't call NVIDIA NIM or OpenCode Zen directly (no CORS), so
 * we forward every request through the same-origin Vercel serverless
 * proxy at `/api/chat`. The proxy:
 *   - accepts the user's `Authorization: Bearer <apiKey>` header
 *   - forwards it to the upstream provider
 *   - returns the response verbatim
 *
 * Per-model settings (URL, model name, timeout, max tokens, reasoning
 * effort) are documented in `src/lib/models.ts`.
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
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('/api/chat', {
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

    if (!response.ok) {
      throw await toProxyError(response);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
      model?: string;
      usage?: ChatResponse['usage'];
    };

    const message = data.choices?.[0]?.message;
    const content = message?.content || message?.reasoning_content || '';

    if (!content) {
      throw new Error(
        `${config.name} returned an empty response (both content and reasoning_content are null). ` +
          'This usually means the model spent the whole token budget on internal reasoning.',
      );
    }

    return {
      content,
      model: data.model || config.model,
      usage: data.usage,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `${config.name} request aborted (timed out after ${Math.round(timeoutMs / 1000)}s or user cancelled)`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    linked.dispose();
  }
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
