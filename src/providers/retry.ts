import { LLMError } from './base';

/**
 * Shared retry plumbing for the HTTP provider adapters. The retry semantics
 * are a contract (identical across openai/anthropic/gemini/ollama): retry on
 * 429/5xx/network errors with 500ms·2^n exponential backoff, honoring a
 * `Retry-After` header (seconds or HTTP-date) on 429/5xx; other statuses
 * fail immediately with LLMError(.status).
 */

export const RETRY_BASE_DELAY_MS = 500;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function retryAfterMs(
  res: Response,
  now: () => number = Date.now,
): number | null {
  const v = res.headers.get('Retry-After');
  if (v === null || v.trim() === '') return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const date = new Date(v);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - now());
  return null;
}

export interface RetryFetchArgs {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  maxRetries: number;
  /** Per-attempt timeout in ms; undefined = no timeout. */
  timeoutMs: number | undefined;
  sleep: (ms: number) => Promise<void>;
}

/**
 * One retried fetch + terminal-status classification. Returns the first OK
 * Response, or throws LLMError (with .status for non-retryable statuses).
 */
export async function retryFetch(args: RetryFetchArgs): Promise<Response> {
  const { fetchImpl, url, init, maxRetries, timeoutMs, sleep } = args;
  let lastError: LLMError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Per-attempt timeout: a hung endpoint aborts like a network error and
    // is retried like one.
    const controller = new AbortController();
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      lastError = new LLMError(
        `network error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt < maxRetries) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
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
      if (attempt < maxRetries) {
        const raMs = retryAfterMs(res);
        await sleep(raMs ?? RETRY_BASE_DELAY_MS * 2 ** attempt);
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
    return res;
  }
  throw lastError ?? new LLMError('request failed');
}
