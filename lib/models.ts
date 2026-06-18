import type { ModelConfig, ModelId } from './types';

export const MODELS: Record<ModelId, ModelConfig> = {
  'nvidia-gpt-oss-120b': {
    id: 'nvidia-gpt-oss-120b',
    name: 'NVIDIA GPT-OSS-120B',
    description: 'OpenAI GPT-OSS-120B served via NVIDIA NIM (integrate.api.nvidia.com). Low reasoning effort.',
    baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'openai/gpt-oss-120b',
    reasoningEffort: 'low',
    docsUrl: 'https://build.nvidia.com/openai/gpt-oss-120b',
    timeoutMs: 120_000,
    defaultMaxTokens: 2048,
  },
  'opencode-glm-5.1': {
    id: 'opencode-glm-5.1',
    name: 'OpenCode Zen — GLM 5.1',
    description: 'GLM 5.1 via opencode.ai/zen/go (reasoning disabled for full output budget).',
    baseUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
    model: 'glm-5.1',
    reasoningEffort: 'none',
    docsUrl: 'https://opencode.ai/docs/zen',
    timeoutMs: 50_000,
    defaultMaxTokens: 4096,
  },
};

export const DEFAULT_MODEL: ModelId = 'nvidia-gpt-oss-120b';

export const STAGE_TEMPERATURES = {
  intent: 0.3,
  copy: 0.3,
  compliance: 0.1,
  refine: 0.2,
} as const;

export const STAGE_MAX_TOKENS = {
  intent: 2048,
  copy: 2048,
  compliance: 1024,
  refine: 2048,
} as const;
