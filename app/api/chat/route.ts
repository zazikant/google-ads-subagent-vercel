/**
 * Vercel serverless proxy — `/api/chat`.
 *
 * The browser can't call NVIDIA NIM or OpenCode Zen directly because those
 * endpoints don't return CORS headers. This proxy accepts a chat completion
 * request from the same-origin Next.js frontend and forwards it server-side.
 *
 * The user's API key travels in the `Authorization: Bearer` header of this
 * request and is forwarded upstream as-is. Nothing is stored.
 *
 * Implements the EXACT request shape used by:
 *   - D:\test\ax-translator\src\lib\nvidia-client.ts   (NVIDIA, 120s timeout)
 *   - D:\test\ax-opencode-translator\src\lib\llm-client.ts  (OpenCode, 50s, reasoning_effort="none")
 */

interface ChatRequest {
  model: 'nvidia-gpt-oss-120b' | 'opencode-glm-5.1';
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

interface ProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly defaultMaxTokens: number;
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  readonly acceptsReasoningNone: boolean;
}

const PROVIDERS: Record<ChatRequest['model'], ProviderConfig> = {
  'nvidia-gpt-oss-120b': {
    baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'openai/gpt-oss-120b',
    defaultMaxTokens: 2048,
    // NVIDIA gateway rejects 'none' — valid values: 'low' | 'medium' | 'high'
    reasoningEffort: 'low',
    acceptsReasoningNone: false,
  },
  'opencode-glm-5.1': {
    baseUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
    model: 'glm-5.1',
    defaultMaxTokens: 4096,
    // OpenCode Zen accepts 'none' (must be string, not int)
    reasoningEffort: 'none',
    acceptsReasoningNone: true,
  },
};

const ALLOWED_MODELS = new Set(Object.keys(PROVIDERS));

export async function POST(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing Authorization: Bearer header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const apiKey = auth.slice('Bearer '.length).trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Empty API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.model || !ALLOWED_MODELS.has(body.model)) {
    return new Response(JSON.stringify({ error: `Unknown model: ${body.model}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages must be a non-empty array' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const config = PROVIDERS[body.model];
  const upstreamBody: Record<string, unknown> = {
    model: config.model,
    messages: body.messages,
    max_tokens: body.maxTokens ?? config.defaultMaxTokens,
    temperature: body.temperature ?? 0.3,
    stream: false,
  };
  if (config.reasoningEffort) {
    upstreamBody.reasoning_effort = config.reasoningEffort;
  }

  try {
    const upstream = await fetch(config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `Upstream call failed: ${msg}` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
