export type ModelId = 'nvidia-gpt-oss-120b' | 'opencode-glm-5.1';

export type StageId = 'intent' | 'copy' | 'validate' | 'refine';

export type PhaseStatus = 'idle' | 'running' | 'done';

export type PipelineMode = 'fast' | 'full';

export interface ModelConfig {
  readonly id: ModelId;
  readonly name: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly docsUrl: string;
  readonly timeoutMs: number;
  readonly defaultMaxTokens: number;
  /**
   * Value to send as `reasoning_effort` for reasoning models.
   * - 'low' for OpenCode Zen — GLM 5.3 (behind the glm-5.1 alias) is
   *   thinking-only and rejects 'none'; 'low' keeps reasoning overhead minimal.
   * - 'low' for NVIDIA NIM gateway (lowest valid value — minimizes but does
   *   not eliminate chain-of-thought)
   * - undefined for non-reasoning models
   */
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /**
   * Multiplier applied to inter-stage adaptive cooldowns.
   * - 1   = full NVIDIA-style cooldowns (3/10/20/30s based on prior stage)
   * - 0   = skip cooldowns entirely (fast/reliable providers)
   * - 0.3 = short cooldowns (mild pacing)
   */
  readonly cooldownMultiplier?: number;
  /**
   * Multiplier on retry backoff sleeps. Use < 1 for fast/reliable providers
   * that should recover quickly (OpenCode Zen), and 1 for slow providers
   * that need longer backoff (NVIDIA NIM on 429s).
   */
  readonly retryBackoffMultiplier?: number;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  /** Fired for every live content chunk as it arrives from the model. */
  readonly onChunk?: (text: string, reasoning: boolean) => void;
  /** Fired for every structured log line emitted by the streaming proxy. */
  readonly onLog?: (line: string) => void;
}

export interface ChatResponse {
  readonly content: string;
  readonly model: string;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

export interface AdCopy {
  readonly headlines: string[];
  readonly descriptions: string[];
}

export interface ValidationReport {
  readonly isValid: boolean;
  readonly qualityScore: number;
  readonly notes: string;
  readonly issues: string[];
  readonly fixes?: Record<string, string>;
}

export interface AdResult extends AdCopy {
  readonly compliance: string;
}

export interface StageLog {
  readonly stage: StageId;
  readonly status: PhaseStatus;
  readonly text: string;
}

export interface PipelineInput {
  readonly modelId: ModelId;
  readonly apiKey: string;
  readonly product: string;
  readonly audience: string;
  readonly tone: string;
  readonly signal?: AbortSignal;
  readonly onStage: (log: StageLog) => void;
  readonly onLog?: (line: string) => void;
  readonly onChunk?: (text: string, phase: StageId) => void;
  readonly mode?: PipelineMode;
  readonly threshold?: number;
  readonly maxRefinements?: number;
}

export interface PipelineOutput {
  readonly ad: AdResult;
  readonly stages: ReadonlyArray<StageLog>;
  readonly pipeline: ReadonlyArray<string>;
  readonly score: number;
  readonly attempts: number;
  readonly refinements: number;
  readonly mode: PipelineMode;
}
