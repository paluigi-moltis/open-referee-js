import type { ChatMessage, LLMResponse, ModelSpec } from './base';
import { LLMError } from './base';
import type { RateLimiter } from './rate_limit';

export interface GeminiProviderOptions {
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** Per-attempt timeout in seconds (AbortController); undefined = no timeout. */
  timeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
  apiKey: string;
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

const RETRY_BASE_DELAY_MS = 500;

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

export class GeminiProvider {
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
  }: GeminiProviderOptions) {
    this.apiKey = apiKey;
    this.rateLimiter = rateLimiter;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.maxRetries = Math.max(0, Math.floor(maxRetries));
    this.timeoutMs =
      timeoutS !== undefined && timeoutS > 0 ? timeoutS * 1000 : undefined;
    this.sleep = sleep ?? defaultSleep;
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    await this.rateLimiter?.gate('gemini');
    const systemParts = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content);
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: spec.temperature,
        maxOutputTokens: spec.maxTokens,
      },
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    }

    const init: RequestInit = {
      method: 'POST',
      headers: {
        // Owner decision: the API key rides in the 'x-goog-api-key' header
        // instead of a ?key= query parameter so keys never appear in URLs
        // (proxy logs, browser history).
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    };

    const url = `${GEMINI_BASE}/${spec.model}:generateContent`;

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
        res = await this.fetchImpl(url, {
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

      let parsed: GenerateContentResponse;
      try {
        parsed = (await res.json()) as GenerateContentResponse;
      } catch {
        throw new LLMError('malformed JSON response from provider');
      }
      const cand = parsed.candidates?.[0]?.content?.parts;
      if (cand === undefined) {
        throw new LLMError(
          'Malformed Gemini response: missing candidates[0].content.parts',
        );
      }
      const text = cand.map((p) => p.text ?? '').join('');
      return {
        content: text,
        usage: {
          promptTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
          completionTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
        },
        model: parsed.modelVersion ?? spec.model,
      };
    }
    throw lastError ?? new LLMError('request failed');
  }

  close(): void {}
}
