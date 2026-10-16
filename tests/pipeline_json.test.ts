import { describe, expect, it } from 'vitest';
import { extractJson } from '../src/pipeline/json';
import { LLMError } from '../src/providers/base';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses a bare JSON array', () => {
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('parses a ```json fenced block', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('parses a ``` fenced block without a language tag', () => {
    expect(extractJson('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON with leading prose', () => {
    expect(extractJson('Here is the result:\n{"a": 1, "b": [2]}')).toEqual({
      a: 1,
      b: [2],
    });
  });

  it('parses JSON with trailing prose', () => {
    expect(extractJson('{"a": 1}\nLet me know if you need anything else.')).toEqual({
      a: 1,
    });
  });

  it('parses JSON with both leading and trailing prose', () => {
    expect(
      extractJson('Sure! The JSON output is:\n{"comments": []}\nHope this helps.'),
    ).toEqual({ comments: [] });
  });

  it('skips a decoy object embedded in prose and finds the fenced JSON', () => {
    const text = 'The answer {is not this} is:\n```json\n{"ok": true}\n```';
    expect(extractJson(text)).toEqual({ ok: true });
  });

  it('handles nested braces inside strings when scanning', () => {
    expect(extractJson('{"s": "a } b", "t": 1}')).toEqual({ s: 'a } b', t: 1 });
  });

  it('handles escaped quotes inside strings when scanning', () => {
    expect(extractJson('prefix {"s": "a \\" b"} suffix')).toEqual({ s: 'a " b' });
  });

  it('throws LLMError on pure garbage', () => {
    expect(() => extractJson('no json here at all')).toThrow(LLMError);
    expect(() => extractJson('no json here at all')).toThrow(
      /invalid JSON in model response/,
    );
  });

  it('throws LLMError on truncated JSON', () => {
    expect(() => extractJson('{"a": 1')).toThrow(LLMError);
  });

  it('throws LLMError on an empty string', () => {
    expect(() => extractJson('')).toThrow(LLMError);
  });

  it('throws LLMError on an unclosed fence with garbage body', () => {
    expect(() => extractJson('```json\nnot json at all')).toThrow(LLMError);
  });

  it('still extracts valid JSON from an unclosed fence', () => {
    expect(extractJson('```json\n{"a": 1}')).toEqual({ a: 1 });
  });
});
