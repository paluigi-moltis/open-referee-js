import { describe, expect, it } from 'vitest';
import { LLMError } from '../src/providers/base';
import type { ModelSpec } from '../src/providers/base';
import { OllamaProvider, DEFAULT_OLLAMA_BASE_URL } from '../src/providers/ollama';
import { RateLimiter } from '../src/providers/rate_limit';

const BASE = 'http://localhost:11434';

function spec(): ModelSpec {
  return { provider: 'p1', model: 'llama-test', temperature: 0.3, maxTokens: 512 };
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
      message: { role: 'assistant', content: 'hello there' },
      prompt_eval_count: 12,
      eval_count: 4,
      model: 'llama-test-actual',
    }),
  );
}

function provider(impl: typeof fetch, extra = {}) {
  return new OllamaProvider({ fetchImpl: impl, ...extra });
}

describe('OllamaProvider', () => {
  it('defaults the base URL to localhost:11434', async () => {
    const { impl, calls } = mockFetch(() => okResponse());
    const p = provider(impl);
    await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(calls[0]?.url).toBe(`${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
  });

  it('strips trailing slashes from a custom baseUrl', async () => {
    const { impl, calls } = mockFetch(() => okResponse());
    const p = new OllamaProvider({
      baseUrl: 'http://gpu-box:11434///',
      fetchImpl: impl,
    });
    await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(calls[0]?.url).toBe('http://gpu-box:11434/api/chat');
  });

  it('sends the expected request shape with no auth header', async () => {
    const { impl, calls } = mockFetch(() => okResponse());
    const p = provider(impl);
    const res = await p.complete(
      [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      spec(),
    );
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: 'llama-test',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      stream: false,
      options: { temperature: 0.3, num_predict: 512 },
    });
    expect(res).toEqual({
      content: 'hello there',
      usage: { promptTokens: 12, completionTokens: 4 },
      model: 'llama-test-actual',
    });
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
    expect(res.content).toBe('hello there');
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('retries on network error', async () => {
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
    expect(res.content).toBe('hello there');
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

  it('throws LLMError when message.content is missing', async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(JSON.stringify({ message: {}, prompt_eval_count: 1 })),
    );
    const p = provider(impl);
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      /missing message.content/,
    );
  });

  it('keys the rate limiter on the baseUrl', async () => {
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
    expect(order).toEqual([`gate:${BASE}`, 'fetch']);
  });

  it('close() is a no-op', () => {
    const p = provider(async () => jsonResponse('{}'));
    expect(() => p.close()).not.toThrow();
  });
});
