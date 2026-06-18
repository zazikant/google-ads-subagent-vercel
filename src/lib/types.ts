export type ModelId = 'nvidia-gpt-oss-120b' | 'opencode-glm-5.1';

export type StageId = 'intent' | 'copy' | 'compliance';

export type PhaseStatus = 'idle' | 'running' | 'done';

export interface ModelConfig {
  readonly id: ModelId;
  readonly name: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly supportsReasoning: boolean;
  readonly docsUrl: string;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
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

export interface ComplianceReport {
  readonly passed: boolean;
  readonly notes: string;
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
