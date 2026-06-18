# Google Ads AI Subagent

A Vite + React + TypeScript app that turns a one-line product description
into Google Ads copy that actually passes compliance. Three specialized
AI agents run in sequence: **strategy → copy → compliance**, and any
issues the compliance agent flags are applied as fixes before you see
the result.

## Models

Pick one in the config bar:

| Model | Provider | Reasoning | Timeout |
| --- | --- | --- | --- |
| `openai/gpt-oss-120b` | NVIDIA NIM (`integrate.api.nvidia.com`) | `low` | 120s |
| `glm-5.1` | OpenCode Zen (`opencode.ai/zen/go`) | `none` (disabled) | 50s |

Reasoning-effort values are provider-specific: NVIDIA's gateway only
accepts `low | medium | high`; OpenCode Zen accepts `none` to fully
disable chain-of-thought. Both are set per-model in `src/lib/models.ts`.

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
  brackets, fixes trailing commas, falls back to greedy regex. Stops
  the LLM's first love — wrapping valid JSON in ```json fences — from
  breaking the pipeline.
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
