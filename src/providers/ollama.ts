import type { ChatMessage, LLMResponse, ModelSpec } from './base';
import { LLMError } from './base';
import type { RateLimiter } from './rate_limit';

export interface OllamaProviderOptions {
  baseUrl?: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Per-attempt timeout in seconds (AbortController); undefined = no timeout. */
  timeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatChunk {
  message?: { content?: string };
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

const RETRY_BASE_DELAY_MS = 500;

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryAfterMs(res: Response, now: () => number = Date.now): number | null {
  const v = res.headers.get('Retry-After');
  if (v === null || v.trim() === '') return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const date = new Date(v);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - now());
  return null;
}

/** Native Ollama /api/chat adapter (local, no auth header). */
export class OllamaProvider {
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({
    baseUrl,
    rateLimiter,
    fetchImpl,
    maxRetries = 3,
    timeoutS,
    sleep,
  }: OllamaProviderOptions) {
    this.baseUrl = (baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    this.rateLimiter = rateLimiter;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.maxRetries = Math.max(0, Math.floor(maxRetries));
    this.timeoutMs =
      timeoutS !== undefined && timeoutS > 0 ? timeoutS * 1000 : undefined;
    this.sleep = sleep ?? defaultSleep;
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    // Different local endpoints are independent — key the limiter on the
    // baseUrl so two Ollama hosts don't share a delay budget.
    await this.rateLimiter?.gate(this.baseUrl);
    const body = JSON.stringify({
      model: spec.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        temperature: spec.temperature,
        num_predict: spec.maxTokens,
      },
    });
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    };

    let lastError: LLMError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Per-attempt timeout: a hung endpoint aborts like a network error and
      // is retried like one.
      const controller = new AbortController();
      const timer =
        this.timeoutMs !== undefined
          ? setTimeout(() => controller.abort(), this.timeoutMs)
          : undefined;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
          ...init,
          signal: controller.signal,
        });
      } catch (err) {
        lastError = new LLMError(
          `network error: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (attempt < this.maxRetries) {
          await this.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw lastError;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = new LLMError(
          `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
          res.status,
        );
        if (attempt < this.maxRetries) {
          const raMs = retryAfterMs(res);
          await this.sleep(raMs ?? RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        throw new LLMError(
          `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
          res.status,
        );
      }

      let parsed: ChatChunk;
      try {
        parsed = (await res.json()) as ChatChunk;
      } catch {
        throw new LLMError('malformed JSON response from provider');
      }
      const content = parsed.message?.content;
      if (typeof content !== 'string') {
        throw new LLMError('malformed response: missing message.content');
      }
      return {
        content,
        usage: {
          promptTokens: parsed.prompt_eval_count ?? 0,
          completionTokens: parsed.eval_count ?? 0,
        },
        model: parsed.model ?? spec.model,
      };
    }
    throw lastError ?? new LLMError('request failed');
  }

  close(): void {}
}
