import type { ChatMessage, LLMResponse, ModelSpec } from './base';
import { LLMError } from './base';
import type { RateLimiter } from './rate_limit';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatCompletionsResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

const RETRY_BASE_DELAY_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('Retry-After');
  if (v === null) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const date = new Date(v);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

export class OpenAICompatibleProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({
    baseUrl,
    apiKey,
    rateLimiter,
    fetchImpl,
    maxRetries = 3,
    sleep,
  }: OpenAICompatibleOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.rateLimiter = rateLimiter;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.maxRetries = maxRetries;
    this.sleep = sleep ?? defaultSleep;
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    await this.rateLimiter?.gate(this.baseUrl);
    const body = JSON.stringify({
      model: spec.model,
      messages,
      temperature: spec.temperature,
      max_tokens: spec.maxTokens,
    });
    const init: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    };

    let lastError: LLMError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, init);
      } catch (err) {
        lastError = new LLMError(
          `network error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < this.maxRetries) {
          await this.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = new LLMError(
          `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
        if (attempt < this.maxRetries) {
          const raMs = retryAfterMs(res);
          await this.sleep(raMs ?? RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        throw new LLMError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      let parsed: ChatCompletionsResponse;
      try {
        parsed = (await res.json()) as ChatCompletionsResponse;
      } catch {
        throw new LLMError('malformed JSON response from provider');
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new LLMError('malformed response: missing choices[0].message.content');
      }
      return {
        content,
        usage: {
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
        },
        model: parsed.model ?? spec.model,
      };
    }
    throw lastError ?? new LLMError('request failed');
  }

  close(): void {}
}
