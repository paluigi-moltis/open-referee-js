export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface LLMResponse {
  content: string;
  usage: Usage;
  model: string;
}

/** Fully resolved model reference for a single call. */
export interface ModelSpec {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export class LLMError extends Error {
  /** HTTP status when the error came from a response, for programmatic branching. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

/** Uniform chat interface implemented by every provider. */
export interface ChatProvider {
  complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse>;
  close(): void;
}
