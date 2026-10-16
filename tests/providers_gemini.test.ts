import { describe, expect, it } from 'vitest';
import { LLMError } from '../src/providers/base';
import type { ModelSpec } from '../src/providers/base';
import { GeminiProvider } from '../src/providers/gemini';
import { RateLimiter } from '../src/providers/rate_limit';

const MODEL = 'gemini-test';

function spec(): ModelSpec {
  return { provider: 'p1', model: MODEL, temperature: 0.3, maxTokens: 512 };
}

function jsonResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  handler: (call: FetchCall, n: number) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const impl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { impl: impl as typeof fetch, calls };
}

function okResponse() {
  return jsonResponse(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
      modelVersion: 'gemini-test-actual',
    }),
  );
}

function provider(impl: typeof fetch, extra = {}) {
  return new GeminiProvider({ apiKey: 'g-key-1', fetchImpl: impl, ...extra });
}

describe('GeminiProvider', () => {
  it('sends the expected request shape', async () => {
    const { impl, calls } = mockFetch(() => okResponse());
    const p = provider(impl);
    const res = await p.complete(
      [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'system', content: 'also cite' },
        { role: 'user', content: 'more' },
      ],
      spec(),
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    );
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('g-key-1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'hello' }] },
        { role: 'user', parts: [{ text: 'more' }] },
      ],
      systemInstruction: { parts: [{ text: 'be terse\n\nalso cite' }] },
      generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
    });
    expect(res).toEqual({
      content: 'hello world',
      usage: { promptTokens: 12, completionTokens: 4 },
      model: 'gemini-test-actual',
    });
  });

  it('omits systemInstruction when there are no system messages', async () => {
    const { impl, calls } = mockFetch(() => okResponse());
    const p = provider(impl);
    await p.complete([{ role: 'user', content: 'q' }], spec());
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect('systemInstruction' in body).toBe(false);
  });

  it('keeps the key out of the URL', async () => {
    const { impl, calls } = mockFetch(() => okResponse());
    const p = provider(impl);
    await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(calls[0]?.url).not.toContain('key=');
    expect(calls[0]?.url).not.toContain('g-key-1');
  });

  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = mockFetch((_, n) =>
      n === 0
        ? jsonResponse('rate limited', 429, { 'Retry-After': '2' })
        : okResponse(),
    );
    const p = provider(impl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.content).toBe('hello world');
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('retries on network error with exponential backoff', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const calls: FetchCall[] = [];
    const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return okResponse();
    }) as typeof fetch;
    const p = provider(impl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.content).toBe('hello world');
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('throws LLMError with status after exhausting retries on persistent 5xx', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = mockFetch(() => jsonResponse('server on fire', 500));
    const p = provider(impl, {
      maxRetries: 2,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const err = await p.complete([{ role: 'user', content: 'q' }], spec()).then(
      () => {
        throw new Error('expected LLMError');
      },
      (e: LLMError) => e,
    );
    expect(err).toBeInstanceOf(LLMError);
    expect(err.status).toBe(500);
    expect(calls.length).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('throws immediately (no retry) on non-retryable status', async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse('{"error": "bad request"}', 400),
    );
    const p = provider(impl);
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      /400.*bad request/s,
    );
    expect(calls.length).toBe(1);
  });

  it('throws LLMError on malformed JSON response', async () => {
    const { impl } = mockFetch(() => jsonResponse('this is not json {', 200));
    const p = provider(impl);
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      LLMError,
    );
  });

  it('throws LLMError when candidates[0] is missing', async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(JSON.stringify({ candidates: [], usageMetadata: {} })),
    );
    const p = provider(impl);
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      /Malformed Gemini response/,
    );
  });

  it('throws LLMError (not TypeError) when parts is not an array', async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(JSON.stringify({ candidates: [{ content: { parts: 'oops' } }] })),
    );
    const p = provider(impl);
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      LLMError,
    );
  });

  it('calls rateLimiter.gate with the gemini key before fetch', async () => {
    const order: string[] = [];
    const { impl } = mockFetch(() => {
      order.push('fetch');
      return okResponse();
    });
    const limiter = new RateLimiter(0);
    limiter.gate = async (key: string) => {
      order.push(`gate:${key}`);
    };
    const p = provider(impl, { rateLimiter: limiter });
    await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(order).toEqual(['gate:gemini', 'fetch']);
  });

  it('close() is a no-op', () => {
    const p = provider(async () => jsonResponse('{}'));
    expect(() => p.close()).not.toThrow();
  });
});
