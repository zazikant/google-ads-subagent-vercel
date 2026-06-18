# Google Ads AI Subagent

A Vite + React + TypeScript app that turns a one-line product description
into Google Ads copy that actually passes compliance. Three specialized
AI agents run in sequence: **strategy → copy → compliance**, and any
issues the compliance agent flags are applied as fixes before you see
the result.

## Models

Pick one in the config bar:

| Model | Provider | Notes |
| --- | --- | --- |
| `openai/gpt-oss-120b` | NVIDIA NIM (`integrate.api.nvidia.com`) | Default. |
| `glm-5.1` | OpenCode Zen (`opencode.ai/zen/go`) | Reasoning disabled for full output budget. |

Your API key is stored only in `localStorage`; the app makes calls
straight to the provider — no proxy, no server.

## Stack

- **Vite 8** + **React 19** + **TypeScript 6**
- Pure CSS, no UI framework
- Lint: `eslint` + `typescript-eslint` + `react-hooks` + `react-refresh`
- Deploy: Vercel static (no server functions)

## Scripts

```bash
npm install
npm run dev        # vite dev server
npm run build      # tsc -b && vite build
npm run preview    # serve the production build locally
npm run lint       # eslint .
```

## Deploy to Vercel

1. Push the repo to GitHub.
2. Import the repo in Vercel — framework preset auto-detects as Vite.
3. No env vars required. Build command: `npm run build`. Output: `dist`.
4. SPA rewrites are configured in `vercel.json`.

## Architecture

```
src/
  lib/
    types.ts         - shared types
    models.ts        - model registry + stage temperatures
    jsonParser.ts    - robust LLM JSON parser (4-tier recovery)
    llmClient.ts     - OpenAI-compatible chat completion wrapper
    pipeline.ts      - 3-stage orchestration (intent → copy → compliance)
  components/
    ConfigBar.tsx    - model + API key input
    PhaseTracker.tsx - live status of each stage
    AdResult.tsx     - Google-style preview + copy button
  App.tsx            - root component
  App.css            - styles
```

## Why these patterns?

Ported from
[atomic-graph-opencode](https://github.com/zazikant/atomic-graph-opencode)
and
[ax-translator](https://github.com/zazikant/ax-translator):

- **Stage-specific temperatures** — intent/copy at 0.3 (focused),
  compliance at 0.1 (objective). Lower temperature = more deterministic
  judgement.
- **Dynamic `max_tokens` per stage** — intent/copy get 2048, compliance
  gets 1024. Compliance just returns small JSON.
- **Robust JSON parser** — strips code fences, extracts balanced
  brackets, falls back to greedy regex. Stops the LLM's first love —
  wrapping valid JSON in ```json fences — from breaking the pipeline.
- **Reasoning-model fallback** — OpenCode's GLM 5.1 returns
  `reasoning_content` when `content` is empty. We fall back
  automatically and disable thinking via `reasoning_effort: "none"`.
- **User-friendly errors** — 401/403/404/429/5xx each map to a specific
  message instead of dumping the raw body.
- **AbortController plumbing** — user can cancel mid-run, and every fetch
  has a 120s timeout.
