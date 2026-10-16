import type { ChatMessage, LLMResponse, ModelSpec } from './base';
import { LLMError } from './base';
import type { RateLimiter } from './rate_limit';

export interface AnthropicProviderOptions {
  apiKey: string;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Per-attempt timeout in seconds (AbortController); undefined = no timeout. */
  timeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface MessagesResponse {
  content?: { text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

const RETRY_BASE_DELAY_MS = 500;

// Single upstream endpoint — the rate limiter is keyed on this constant so
// every Anthropic call shares one delay budget.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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

export class AnthropicProvider {
  private readonly apiKey: string;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor({
    apiKey,
    rateLimiter,
    fetchImpl,
    maxRetries = 3,
    timeoutS,
    sleep,
  }: AnthropicProviderOptions) {
    this.apiKey = apiKey;
    this.rateLimiter = rateLimiter;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.maxRetries = Math.max(0, Math.floor(maxRetries));
    this.timeoutMs =
      timeoutS !== undefined && timeoutS > 0 ? timeoutS * 1000 : undefined;
    this.sleep = sleep ?? defaultSleep;
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    await this.rateLimiter?.gate('anthropic');
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model: spec.model,
      max_tokens: spec.maxTokens,
      temperature: spec.temperature,
      messages: turns,
    };
    if (system !== '') body.system = system;
    // No JSON mode in Stage 2; the Python adapter's assistant "{" prefill
    // would slot in here when JSON mode lands.

    const init: RequestInit = {
      method: 'POST',
      headers: {
        // Owner decision: 'anthropic-dangerous-direct-browser-access' is
        // required for CORS when calling the Anthropic API directly from a
        // browser (https://docs.anthropic.com/en/api/client-sdks#direct-browser-access).
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
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
        res = await this.fetchImpl(ANTHROPIC_URL, {
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

      let parsed: MessagesResponse;
      try {
        parsed = (await res.json()) as MessagesResponse;
      } catch {
        throw new LLMError('malformed JSON response from provider');
      }
      const text = (parsed.content ?? []).map((b) => b.text ?? '').join('');
      if (parsed.content === undefined) {
        throw new LLMError('malformed response: missing content field');
      }
      return {
        content: text,
        usage: {
          promptTokens: parsed.usage?.input_tokens ?? 0,
          completionTokens: parsed.usage?.output_tokens ?? 0,
        },
        model: parsed.model ?? spec.model,
      };
    }
    throw lastError ?? new LLMError('request failed');
  }

  close(): void {}
}
