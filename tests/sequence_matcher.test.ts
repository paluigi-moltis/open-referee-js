import { describe, expect, it } from 'vitest';
import { SequenceMatcher, similarityRatio } from '../src/util/sequence_matcher';

// ===== Python-generated expected values (`uv run python` difflib in the
// open-referee repo; PY_* repr pattern from tests/bibliography.test.ts).
// 26 hand-picked (a, b) pairs incl. unicode, punctuation, repeated tokens;
// the pinned ratio is difflib.SequenceMatcher(None, a, b).ratio() exactly.

const PY_PAIRS: [string, string, number][] = [
  ['', '', 1.0],
  ['', 'abc', 0.0],
  ['abc', '', 0.0],
  ['abc', 'abc', 1.0],
  ['abc', 'abd', 0.6666666666666666],
  ['abcd', 'abce', 0.75],
  ['kitten', 'sitting', 0.6153846153846154],
  ['abcdef', 'xbcefg', 0.6666666666666666],
  ['the quick brown fox', 'the quick brown dog', 0.8947368421052632],
  ['aXbXc', 'abc', 0.75],
  ['aaaa', 'aa', 0.6666666666666666],
  ['aaabbb', 'bbbaaa', 0.5],
  ['flibble', 'fribble', 0.8571428571428571],
  ['héllo wörld', 'hello world', 0.8181818181818182],
  ['café naïve', 'cafe naive', 0.8],
  ['日本語のテキスト', '日本語テキスト', 0.9333333333333333],
  ['münchen', 'munich', 0.6153846153846154],
  ['a, b; c! d?', 'a b c d', 0.7777777777777778],
  ['proceedings of the', 'proceedings of the acm', 0.9],
  [
    'statistical learning theory',
    'the theory of statistical learning',
    0.6557377049180327,
  ],
  ['machine learning (2001)', 'machine learning 2001', 0.9545454545454546],
  ['foo bar foo bar', 'bar foo bar foo', 0.7333333333333333],
  ['ABCDEF', 'abcdef', 0.0],
  ['ab cd ef', 'ef ab cd', 0.625],
  ['x', 'x', 1.0],
  ['%.2f and (0.72)', '0.72 and 2f', 0.6153846153846154],
];

describe('SequenceMatcher (parity with difflib)', () => {
  it('ratio() matches Python exactly on 26 pinned pairs', () => {
    expect(PY_PAIRS.length).toBeGreaterThanOrEqual(20);
    for (const [a, b, expected] of PY_PAIRS) {
      expect(similarityRatio(a, b), JSON.stringify([a, b])).toBe(expected);
    }
  });

  it('ratio() is memoized like Python', () => {
    const sm = new SequenceMatcher('kitten', 'sitting');
    expect(sm.ratio()).toBe(sm.ratio());
  });

  it('getMatchingBlocks ends with the sentinel zero block', () => {
    const blocks = new SequenceMatcher('abc', 'abd').getMatchingBlocks();
    expect(blocks).toEqual([
      { a: 0, b: 0, size: 2 },
      { a: 3, b: 3, size: 0 },
    ]);
  });

  it('empty vs empty is ratio 1.0 (Python convention)', () => {
    expect(similarityRatio('', '')).toBe(1.0);
  });

  it('findLongestMatch picks the earliest of equal-length blocks', () => {
    // Python: ties go to the first (smallest i, j) match.
    const sm = new SequenceMatcher('abab', 'ab');
    const m = sm.findLongestMatch(0, 4, 0, 2);
    expect(m).toEqual({ a: 0, b: 0, size: 2 });
  });

  it('handles repeated tokens symmetrically with difflib', () => {
    // aaabbb vs bbbaaa: two length-3 blocks -> 2*6/12
    expect(similarityRatio('aaabbb', 'bbbaaa')).toBeCloseTo(0.5, 12);
  });

  it('works on astral-plane characters as code points (surrogate pairs)', () => {
    // Array.from iterates code points; Python 3 strings are code points too.
    expect(similarityRatio('𝐀𝐁𝐂', '𝐀𝐁𝐃')).toBeCloseTo((2 * 2) / 6, 12);
  });
});
