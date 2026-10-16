import { describe, expect, it } from 'vitest';
import { LLMError } from '../src/providers/base';
import { createProvider, closeProviders } from '../src/providers/factory';
import { FakeProvider } from '../src/providers/fake';
import { AnthropicProvider } from '../src/providers/anthropic';
import { GeminiProvider } from '../src/providers/gemini';
import { OllamaProvider, DEFAULT_OLLAMA_BASE_URL } from '../src/providers/ollama';
import { OpenAICompatibleProvider } from '../src/providers/openai';

const BASE = 'https://api.example.com/v1';

describe('createProvider', () => {
  it('maps openai_compatible to OpenAICompatibleProvider', () => {
    const p = createProvider({ providerType: 'openai_compatible', baseUrl: BASE });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('maps vllm to OpenAICompatibleProvider', () => {
    const p = createProvider({ providerType: 'vllm', baseUrl: BASE });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('throws when openai_compatible has no baseUrl', () => {
    expect(() =>
      createProvider({ providerType: 'openai_compatible', apiKey: 'k' }),
    ).toThrow(LLMError);
    expect(() =>
      createProvider({ providerType: 'openai_compatible', apiKey: 'k' }),
    ).toThrow(/needs a base_url/);
  });

  it('maps anthropic to AnthropicProvider', () => {
    const p = createProvider({ providerType: 'anthropic', apiKey: 'sk-1' });
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  it('throws when anthropic has no API key', () => {
    expect(() => createProvider({ providerType: 'anthropic' })).toThrow(LLMError);
    expect(() => createProvider({ providerType: 'anthropic' })).toThrow(
      /has no API key resolved/,
    );
  });

  it('maps gemini to GeminiProvider', () => {
    const p = createProvider({ providerType: 'gemini', apiKey: 'g-1' });
    expect(p).toBeInstanceOf(GeminiProvider);
  });

  it('throws when gemini has no API key', () => {
    expect(() => createProvider({ providerType: 'gemini' })).toThrow(LLMError);
    expect(() => createProvider({ providerType: 'gemini' })).toThrow(
      /has no API key resolved/,
    );
  });

  it('maps ollama to OllamaProvider with the default base URL', () => {
    const p = createProvider({ providerType: 'ollama' });
    expect(p).toBeInstanceOf(OllamaProvider);
    expect(DEFAULT_OLLAMA_BASE_URL).toBe('http://localhost:11434');
  });

  it('maps fake to FakeProvider, ignoring apiKey', () => {
    const p = createProvider({ providerType: 'fake', apiKey: 'ignored' });
    expect(p).toBeInstanceOf(FakeProvider);
  });

  it('passes timeout and retry options through', async () => {
    let attempts = 0;
    const p = createProvider({
      providerType: 'ollama',
      baseUrl: 'http://localhost:11434',
      maxRetries: 2,
      fetchImpl: async () => {
        attempts += 1;
        return new Response('boom', { status: 500 });
      },
      sleep: async () => undefined,
    });
    expect(p).toBeInstanceOf(OllamaProvider);
    await expect(
      p.complete([{ role: 'user', content: 'q' }], {
        provider: 'p',
        model: 'm',
        temperature: 0,
        maxTokens: 1,
      }),
    ).rejects.toThrow(LLMError);
    expect(attempts).toBe(3); // maxRetries honored through the factory
  });
});

describe('closeProviders', () => {
  it('calls close() on every provider', () => {
    let closed = 0;
    const providers: Record<string, FakeProvider> = {
      a: new FakeProvider(),
      b: new FakeProvider(),
      c: new FakeProvider(),
    };
    for (const p of Object.values(providers)) {
      p.close = () => {
        closed += 1;
      };
    }
    closeProviders(providers);
    expect(closed).toBe(3);
  });

  it('tolerates an empty map', () => {
    expect(() => closeProviders({})).not.toThrow();
  });
});
