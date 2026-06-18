import { MODELS } from './models';
import type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ModelConfig,
  ModelId,
} from './types';

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Send a chat completion to an OpenAI-compatible endpoint.
 *
 * Supports two providers out of the box:
 *   - NVIDIA NIM (openai/gpt-oss-120b)
 *   - OpenCode Zen (glm-5.1, with reasoning disabled)
 *
 * Falls back to `reasoning_content` for reasoning models that exhaust the
 * output budget on chain-of-thought and return an empty `content` field.
 */
export async function chatCompletion(
  modelId: ModelId,
  apiKey: string,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResponse> {
  const config = MODELS[modelId];
  const controller = new AbortController();
  const linked = linkSignals(controller, options.signal);
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: options.maxTokens ?? 2048,
    temperature: options.temperature ?? 0.3,
    stream: false,
  };

  if (config.supportsReasoning) {
    // GLM 5.1 thinks by default; turn it off so all tokens land in `content`.
    body.reasoning_effort = 'none';
  }

  try {
    const response = await fetch(config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw await toApiError(response, config);
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
        `${config.name} request aborted (timed out after 120s or user cancelled)`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    linked.dispose();
  }
}

async function toApiError(response: Response, config: ModelConfig): Promise<Error> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message || parsed.message || text;
    } catch {
      detail = text;
    }
  } catch {
    // ignore
  }

  if (response.status === 401) {
    return new Error(`Invalid API key for ${config.name}. Double-check the key in the config bar.`);
  }
  if (response.status === 403) {
    return new Error(`Access denied by ${config.name} — your key may not be allowed to call ${config.model}.`);
  }
  if (response.status === 404) {
    return new Error(`${config.name} could not find model "${config.model}". It may have been renamed or retired.`);
  }
  if (response.status === 429) {
    return new Error(`${config.name} rate-limited the request. Wait a moment and try again.`);
  }
  if (response.status >= 500) {
    return new Error(`${config.name} server error (${response.status}): ${detail || 'no body'}. Usually temporary.`);
  }
  return new Error(`${config.name} API error (${response.status}): ${detail || 'no body'}`);
}

interface LinkedSignals {
  readonly dispose: () => void;
}

/**
 * Combine a parent AbortSignal with our internal timeout/controller so
 * either side can cancel the in-flight fetch.
 */
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
