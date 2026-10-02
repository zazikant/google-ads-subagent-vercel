import { NextRequest } from 'next/server';
import { chatCompletionControlled } from '@/lib/controlledStream';
import type { ChatMessage, ModelId } from '@/lib/types';
import { MODELS } from '@/lib/models';

/**
 * Streaming chat completion proxy (Server-Sent Events).
 *
 * POST /api/chat-stream
 *   Authorization: Bearer <apiKey>
 *   body: { model, messages, maxTokens?, temperature?, reasoningEffort? }
 *
 * Response: text/event-stream with structured events:
 *   data: {"type":"log","line":"[stream] start provider=...","ts":...}
 *   data: {"type":"chunk","text":"Hello","reasoning":false,"ts":...}
 *   data: {"type":"chunk","text":"...","reasoning":true,"ts":...}
 *   data: {"type":"done","content":"...","reasoning":"...","model":"...","elapsedMs":1234,"attempts":1,"continuations":0,"truncated":false,"usage":null,"ts":...}
 *   data: {"type":"error","message":"...","ts":...}
 *
 * Why this endpoint:
 *   The browser can't call NVIDIA NIM / OpenCode Zen directly (no CORS).
 *   The legacy /api/chat route is non-streaming and has no retry/timeout
 *   handling — a single transient error or 429 makes the whole ads pipeline
 *   fail. This route:
 *     - Sets stream:true upstream so users see live tokens (no "frozen" UI)
 *     - Per-call AbortController timeout tuned per provider (120s NVIDIA,
 *       50s OpenCode — see lib/models.ts)
 *     - Up to 3 attempts with exponential backoff (500ms, 1s, 2s)
 *     - 429 rate-limit aware: 5s / 15s / 30s backoff, Retry-After honoured
 *     - Reasoning-as-content fallback when only reasoning_content returned
 *     - Auto-continue on finish_reason:'length' — when the model hits
 *       max_tokens mid-generation, automatically sends another call with
 *       the partial output appended as an assistant message + a generic
 *       "continue from where you left off" user prompt, then concatenates.
 *       The browser sees continuous streaming with no visible boundary
 *       between the original call and continuation(s). Capped at 3 rounds.
 *
 * Edge runtime: required for streaming + long-lived requests on Vercel.
 * maxDuration 120s matches NVIDIA's timeout (slowest provider).
 */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

interface StreamRequest {
  model: ModelId;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

export async function POST(req: NextRequest): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(405, { error: 'Method not allowed' });
  }

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return jsonError(401, { error: 'Missing Authorization: Bearer header' });
  }
  const apiKey = auth.slice('Bearer '.length).trim();
  if (!apiKey) {
    return jsonError(401, { error: 'Empty API key' });
  }

  let body: StreamRequest;
  try {
    body = (await req.json()) as StreamRequest;
  } catch {
    return jsonError(400, { error: 'Invalid JSON body' });
  }

  if (!body.model || !(body.model in MODELS)) {
    return jsonError(400, { error: `Unknown model: ${String(body.model)}` });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, { error: 'messages must be a non-empty array' });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...event, ts: Date.now() })}\n\n`));
        } catch {
          // Controller may be closed if the client disconnected.
        }
      };

      try {
        const result = await chatCompletionControlled({
          modelId: body.model,
          apiKey,
          messages: body.messages,
          temperature: body.temperature,
          maxTokens: body.maxTokens,
          onLog: (line) => emit({ type: 'log', line }),
          onChunk: (text, reasoning) => emit({ type: 'chunk', text, reasoning }),
        });

        emit({
          type: 'done',
          content: result.content,
          reasoning: result.reasoning,
          model: result.model,
          elapsedMs: result.elapsedMs,
          attempts: result.attempts,
          continuations: result.continuations,
          truncated: result.truncated,
          usage: null,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: 'error', message: msg });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable Nginx/proxy buffering
    },
  });
}

function jsonError(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}