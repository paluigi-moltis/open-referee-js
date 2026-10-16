import type { ChatMessage, LLMResponse, ModelSpec } from './base';
import { LLMError } from './base';

/** Scripted test double mirroring the Python FakeProvider. */
export class FakeProvider {
  readonly calls: { messages: ChatMessage[]; spec: ModelSpec }[] = [];
  private queueContents: string[] = [];

  queue(...contents: string[]): void {
    this.queueContents.push(...contents);
  }

  async complete(messages: ChatMessage[], spec: ModelSpec): Promise<LLMResponse> {
    const content = this.queueContents.shift();
    if (content === undefined) {
      throw new LLMError('fake provider queue empty');
    }
    this.calls.push({ messages, spec });
    return { content, usage: { promptTokens: 10, completionTokens: 5 }, model: 'fake' };
  }

  close(): void {}
}
