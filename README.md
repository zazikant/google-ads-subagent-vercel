# Google Ads AI Subagent

A **Next.js + TypeScript** app that turns a one-line product description into
Google Ads copy that actually passes compliance. Four specialized activities
run in sequence: **strategy → copy → validate → refine**, and any issues
the compliance activity flags are applied as fixes before you see the
result. Backed by a same-origin Vercel serverless proxy at `/api/chat`
so the browser never talks directly to NVIDIA / OpenCode.

## Models

Pick one in the config bar:

| Model | Provider | Reasoning | Timeout |
| --- | --- | --- | --- |
| `openai/gpt-oss-120b` | NVIDIA NIM (`integrate.api.nvidia.com`) | `low` | 120s |
| `glm-5.1` | OpenCode Zen (`opencode.ai/zen/go`) | `none` (disabled) | 50s |

Reasoning-effort values are provider-specific: NVIDIA's gateway only
accepts `low | medium | high`; OpenCode Zen accepts `none` to fully
disable chain-of-thought. Both are set per-model in `lib/models.ts`.

Your API key is stored only in `localStorage`; the app makes calls
straight to the provider via the same-origin Vercel serverless function —
no proxy the user has to trust, no logs.

## Stack

- **Next.js 14** (App Router) + **TypeScript 5**
- **React 18** with client components for the interactive parts
- Pure CSS, no UI framework
- Lint: `next lint` (uses `next/core-web-vitals` + `next/typescript`)
- Deploy: Vercel native (Next.js auto-detected)

## Scripts

```bash
npm install
npm run dev        # next dev
npm run build      # next build
npm run start      # next start (production)
npm run lint       # next lint
```

## Deploy to Vercel

1. Push to GitHub.
2. Import the repo in Vercel — Next.js is auto-detected.
3. No environment variables required. The user provides their own API
   key in the UI; the key is sent in the request `Authorization`
   header to `/api/chat` and forwarded to the upstream provider.
4. `app/api/chat/route.ts` is configured with `maxDuration: 120s` in
   `vercel.json` to handle the slowest provider responses.

## Architecture

```
app/
  layout.tsx              - root layout (server component)
  page.tsx                - home page (client component, all state)
  globals.css             - styles
  api/chat/route.ts       - Vercel serverless proxy (POST handler)
components/
  ConfigBar.tsx           - model + API key input
  PhaseTracker.tsx        - live status of each stage
  AdResult.tsx            - Google-style preview + copy button
lib/
  types.ts                - shared types
  models.ts               - model registry + stage temperatures
  jsonParser.ts           - robust LLM JSON parser
  llmClient.ts            - browser-side fetch wrapper
  pipeline.ts             - AX DSPy-style state machine
```

The browser never calls NVIDIA or OpenCode directly — those endpoints
don't return CORS headers. Instead, it calls `POST /api/chat` (same
origin), and the serverless function in `app/api/chat/route.ts`
forwards the request with the user's bearer token to the upstream
provider.

## Why these patterns?

Ported from
[ax-opencode-translator](https://github.com/zazikant/ax-opencode-translator)
and
[ax-translator](https://github.com/zazikant/ax-translator):

- **AX DSPy-style orchestration** — `ErrorEntry` history, `compileRefinePrompt()`
  (DSPy `Module.compile()` analog), `isEcho()` detection, `resumeFrom`
  state machine. Activities (intent → copy → validate → refine) carry
  results forward, never recompute earlier stages.
- **Stage-specific temperatures** — intent/copy at 0.3 (focused),
  validate at 0.1 (objective), refine at 0.2 (creative fixes).
- **Dynamic `max_tokens` per stage** — calculated from input length
  (1 token ≈ 4 chars Latin / 2 chars CJK), clamped per-stage.
- **Robust JSON parser** — strips code fences, extracts balanced
  brackets, fixes trailing commas, falls back to greedy regex.
- **Provider-specific reasoning effort** — OpenCode Zen accepts `none`
  (disables CoT entirely); NVIDIA NIM accepts only `low | medium | high`
  (we use `low` to minimize the budget spent on character-counting CoT).
- **User-friendly errors** — 401/403/404/429/5xx each map to a specific
  message instead of dumping the raw body.
- **Per-model timeout** — OpenCode: 50s (matches `ax-opencode-translator`'s
  10s buffer under Vercel's 60s `maxDuration`); NVIDIA: 120s.
- **AbortController plumbing** — user can cancel mid-run, and every fetch
  has a model-specific timeout.
- **Fast mode** — single-pass `intent → copy` for Vercel Hobby plan or
  when speed matters more than validation.
