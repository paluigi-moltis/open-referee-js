import { describe, expect, it } from 'vitest';
import { LLMError } from '../src/providers/base';
import type { ModelSpec } from '../src/providers/base';
import { OpenAICompatibleProvider } from '../src/providers/openai';
import { RateLimiter } from '../src/providers/rate_limit';

const BASE = 'https://api.example.com/v1';

function spec(): ModelSpec {
  return { provider: 'p1', model: 'gpt-test', temperature: 0.3, maxTokens: 512 };
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

describe('OpenAICompatibleProvider', () => {
  it('parses a happy-path completion', async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse(
        JSON.stringify({
          choices: [{ message: { content: 'hello there' } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
          model: 'gpt-test-actual',
        }),
      ),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'sk-1',
      fetchImpl: impl,
    });
    const res = await p.complete(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      spec(),
    );
    expect(res).toEqual({
      content: 'hello there',
      usage: { promptTokens: 12, completionTokens: 4 },
      model: 'gpt-test-actual',
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`${BASE}/chat/completions`);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.3,
      max_tokens: 512,
    });
  });

  it('falls back to spec.model when the response has no model field', async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(
        JSON.stringify({
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: impl,
    });
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.model).toBe('gpt-test');
  });

  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = mockFetch((_, n) =>
      n === 0
        ? jsonResponse('rate limited', 429, { 'Retry-After': '2' })
        : jsonResponse(
            JSON.stringify({
              choices: [{ message: { content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
              model: 'gpt-test',
            }),
          ),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.content).toBe('ok');
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('retries on 5xx with exponential backoff when no Retry-After', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = mockFetch((_, n) =>
      n < 2
        ? jsonResponse('boom', 503)
        : jsonResponse(
            JSON.stringify({
              choices: [{ message: { content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
              model: 'gpt-test',
            }),
          ),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.content).toBe('ok');
    expect(calls.length).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('retries on network error', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const calls: FetchCall[] = [];
    const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return jsonResponse(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: 'gpt-test',
        }),
      );
    }) as typeof fetch;
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const res = await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(res.content).toBe('ok');
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('throws LLMError after exhausting retries on persistent 5xx', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = mockFetch(() => jsonResponse('server on fire', 500));
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: impl,
      maxRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      /server on fire/,
    );
    expect(calls.length).toBe(3); // initial + 2 retries
    expect(sleeps).toEqual([500, 1000]);
  });

  it('throws immediately (no retry) on non-retryable status', async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse('{"error": "bad request"}', 400),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: impl,
    });
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      /400.*bad request/s,
    );
    expect(calls.length).toBe(1);
  });

  it('truncates error bodies to 200 chars', async () => {
    const longBody = 'x'.repeat(500);
    const { impl } = mockFetch(() => jsonResponse(longBody, 400));
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: impl,
    });
    const err = await p
      .complete([{ role: 'user', content: 'q' }], spec())
      .catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message.length).toBeLessThan(longBody.length + 50);
    expect((err as Error).message).toContain('x'.repeat(200));
    expect((err as Error).message).not.toContain('x'.repeat(201));
  });

  it('throws LLMError on malformed JSON response', async () => {
    const { impl } = mockFetch(() => jsonResponse('this is not json {', 200));
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: impl,
    });
    await expect(p.complete([{ role: 'user', content: 'q' }], spec())).rejects.toThrow(
      LLMError,
    );
  });

  it('calls rateLimiter.gate before fetch', async () => {
    const order: string[] = [];
    const { impl } = mockFetch(() => {
      order.push('fetch');
      return jsonResponse(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          model: 'gpt-test',
        }),
      );
    });
    const limiter = new RateLimiter(0);
    limiter.gate = async (key: string) => {
      order.push(`gate:${key}`);
    };
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: impl,
      rateLimiter: limiter,
    });
    await p.complete([{ role: 'user', content: 'q' }], spec());
    expect(order).toEqual([`gate:${BASE}`, 'fetch']);
  });

  it('close() is a no-op', () => {
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: 'k',
      fetchImpl: async () => jsonResponse('{}'),
    });
    expect(() => p.close()).not.toThrow();
  });
});
