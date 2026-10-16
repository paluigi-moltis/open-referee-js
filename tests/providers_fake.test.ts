import { describe, expect, it } from 'vitest';
import { LLMError } from '../src/providers/base';
import type { ChatMessage, ModelSpec } from '../src/providers/base';
import { FakeProvider } from '../src/providers/fake';

function spec(): ModelSpec {
  return { provider: 'fake', model: 'fake-model', temperature: 0.2, maxTokens: 1024 };
}

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

describe('FakeProvider', () => {
  it('pops queued responses in FIFO order', async () => {
    const p = new FakeProvider();
    p.queue('first', 'second', 'third');
    await expect(p.complete([msg('user', 'q1')], spec())).resolves.toEqual({
      content: 'first',
      usage: { promptTokens: 10, completionTokens: 5 },
      model: 'fake',
    });
    await expect(p.complete([msg('user', 'q2')], spec())).resolves.toMatchObject({
      content: 'second',
    });
    await expect(p.complete([msg('user', 'q3')], spec())).resolves.toMatchObject({
      content: 'third',
    });
  });

  it('accepts contents variadically via queue(...contents)', () => {
    const p = new FakeProvider();
    p.queue('a');
    p.queue('b', 'c');
    expect(p.calls.length).toBe(0);
  });

  it('throws LLMError when the queue is dry', async () => {
    const p = new FakeProvider();
    p.queue('only');
    await p.complete([msg('user', 'q')], spec());
    await expect(p.complete([msg('user', 'q')], spec())).rejects.toThrow(LLMError);
    await expect(p.complete([msg('user', 'q')], spec())).rejects.toThrow(/queue empty/);
  });

  it('records every call with messages and spec', async () => {
    const p = new FakeProvider();
    const messages = [msg('system', 'sys'), msg('user', 'question')];
    const s = spec();
    p.queue('resp');
    await p.complete(messages, s);
    expect(p.calls).toEqual([{ messages, spec: s }]);
  });

  it('close() is a no-op', () => {
    const p = new FakeProvider();
    expect(() => p.close()).not.toThrow();
  });
});
