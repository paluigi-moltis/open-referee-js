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
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Uniform chat interface implemented by every provider. */
export interface ChatProvider {
  complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse>;
  close(): void;
}
