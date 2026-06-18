import { chatCompletion } from './llmClient';
import { STAGE_MAX_TOKENS, STAGE_TEMPERATURES } from './models';
import { cleanText, parseLLMJson } from './jsonParser';
import type {
  AdCopy,
  AdResult,
  ChatMessage,
  ComplianceReport,
  ModelId,
  PhaseStatus,
  StageId,
  StageLog,
} from './types';

const INTENT_SYSTEM = `You are a strategic advertising analyst. Extract the core value propositions of a product and map them to user search intent.

Output format (plain text, NOT JSON):
- 3-4 core value propositions (each one short bullet)
- Primary search intent type (informational / commercial / transactional)
- 5 high-intent keywords
- One positioning statement (1 sentence)

Be concise. Do NOT write ad copy yet — that comes in the next stage.`;

const COPY_SYSTEM = `You are a Google Ads copywriter.

Hard rules:
- Each headline MUST be <= 30 characters.
- Each description MUST be <= 90 characters.
- You MUST return valid JSON, no markdown, no commentary, no code fences.
- Provide exactly 5 headlines and 2 descriptions.
- No emojis. No excessive capitalization. No misleading superlatives.
- Tone must match the requested brand tone.

Return ONLY this JSON shape:
{"headlines":["","","","",""],"descriptions":["",""]}`;

const COMPLIANCE_SYSTEM = `You are a Google Ads compliance reviewer.

Check the supplied ad copy for:
- Character limits (headlines <= 30, descriptions <= 90)
- Misleading or unverifiable claims
- Excessive capitalization or punctuation
- All-caps words longer than 4 letters

Return ONLY valid JSON, no markdown, no commentary:
{
  "passed": true,
  "notes": "short summary for the user",
  "fixes": {
    "headline_0": "corrected text",
    "description_1": "corrected text"
  }
}

Omit the "fixes" key entirely when no fixes are needed.`;

export interface PipelineInput {
  readonly modelId: ModelId;
  readonly apiKey: string;
  readonly product: string;
  readonly audience: string;
  readonly tone: string;
  readonly signal?: AbortSignal;
  readonly onStage: (log: StageLog) => void;
}

export interface PipelineOutput {
  readonly ad: AdResult;
  readonly stages: ReadonlyArray<StageLog>;
}

const STAGE_ORDER: ReadonlyArray<StageId> = ['intent', 'copy', 'compliance'];

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const stages: StageLog[] = STAGE_ORDER.map((stage) => ({
    stage,
    status: 'idle' as PhaseStatus,
    text: '',
  }));

  setStage(stages, 'intent', 'running', '');

  // ── Phase 1: Strategic Intent Analysis ─────────────────────────────
  const intentMessages: ChatMessage[] = [
    { role: 'system', content: INTENT_SYSTEM },
    {
      role: 'user',
      content: `Product: ${input.product}\nAudience: ${input.audience || 'General'}\nTone: ${input.tone}`,
    },
  ];
  const intentResult = await chatCompletion(
    input.modelId,
    input.apiKey,
    intentMessages,
    {
      temperature: STAGE_TEMPERATURES.intent,
      maxTokens: STAGE_MAX_TOKENS.intent,
      signal: input.signal,
    },
  );
  const intentText = cleanText(intentResult.content);
  setStage(stages, 'intent', 'done', intentText);

  // ── Phase 2: Copy Generation ───────────────────────────────────────
  setStage(stages, 'copy', 'running', '');
  const copyMessages: ChatMessage[] = [
    { role: 'system', content: COPY_SYSTEM },
    {
      role: 'user',
      content:
        `Strategy from previous stage:\n${intentText}\n\n` +
        `Product: ${input.product}\nAudience: ${input.audience || 'General'}\nTone: ${input.tone}`,
    },
  ];
  const copyResult = await chatCompletion(
    input.modelId,
    input.apiKey,
    copyMessages,
    {
      temperature: STAGE_TEMPERATURES.copy,
      maxTokens: STAGE_MAX_TOKENS.copy,
      signal: input.signal,
    },
  );
  const copyRaw = parseLLMJson<AdCopy>(copyResult.content);
  const copy: AdCopy = {
    headlines: ensureLength(copyRaw.headlines, 5, 'Headline', 30).map((h) => h.slice(0, 30)),
    descriptions: ensureLength(copyRaw.descriptions, 2, 'Description', 90).map((d) => d.slice(0, 90)),
  };
  setStage(
    stages,
    'copy',
    'done',
    `${copy.headlines.length} headlines · ${copy.descriptions.length} descriptions`,
  );

  // ── Phase 3: Compliance Review ─────────────────────────────────────
  setStage(stages, 'compliance', 'running', '');
  const complianceMessages: ChatMessage[] = [
    { role: 'system', content: COMPLIANCE_SYSTEM },
    {
      role: 'user',
      content: `Copy: ${JSON.stringify(copy)}\nProduct: ${input.product}`,
    },
  ];
  const complianceResult = await chatCompletion(
    input.modelId,
    input.apiKey,
    complianceMessages,
    {
      temperature: STAGE_TEMPERATURES.compliance,
      maxTokens: STAGE_MAX_TOKENS.compliance,
      signal: input.signal,
    },
  );
  const report = parseLLMJson<ComplianceReport>(complianceResult.content);
  setStage(stages, 'compliance', 'done', report.notes || (report.passed ? 'All checks passed.' : 'Issues found.'));

  // ── Apply compliance fixes ─────────────────────────────────────────
  const headlines = [...copy.headlines];
  const descriptions = [...copy.descriptions];

  if (report.fixes && typeof report.fixes === 'object') {
    for (const [key, value] of Object.entries(report.fixes)) {
      const match = key.match(/^(headline|description)_(\d+)$/);
      if (!match) continue;
      const idx = Number.parseInt(match[2], 10);
      const trimmed = value.slice(0, match[1] === 'headline' ? 30 : 90);
      if (match[1] === 'headline' && idx >= 0 && idx < headlines.length) {
        headlines[idx] = trimmed;
      } else if (match[1] === 'description' && idx >= 0 && idx < descriptions.length) {
        descriptions[idx] = trimmed;
      }
    }
  }

  const ad: AdResult = {
    headlines,
    descriptions,
    compliance: report.notes || 'Review complete.',
  };

  return { ad, stages };
}

function setStage(stages: StageLog[], id: StageId, status: PhaseStatus, text: string): void {
  const idx = stages.findIndex((s) => s.stage === id);
  if (idx === -1) return;
  stages[idx] = { stage: id, status, text };
}

function ensureLength(
  arr: unknown,
  expected: number,
  label: string,
  charLimit: number,
): string[] {
  const list = Array.isArray(arr) ? arr : [];
  const result: string[] = [];
  for (let i = 0; i < expected; i++) {
    const raw = list[i];
    const value = typeof raw === 'string' ? raw : '';
    result.push(value.slice(0, charLimit) || `${label} ${i + 1}`);
  }
  return result;
}
