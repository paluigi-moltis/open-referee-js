import { describe, expect, it } from 'vitest';
import { BlockType } from '../src/ingestion/document';
import {
  UnsupportedFormatError,
  readMarkdown,
  unsupportedFormat,
} from '../src/ingestion/readers_md';

// Fixture ported verbatim from Python tests/conftest.py SAMPLE_PAPER.
const SAMPLE_PAPER = `# On the Stability of Widget Networks

## 1. Introduction

Widget networks are everywhere. We prove that all widgets are stable
under mild assumptions, extending the classical results of Smith (2001).

## 2. Model

Let G = (V, E) be a widget graph. Each widget has mass m_i > 0.

## 3. Main result

Theorem 1. Every widget network is stable. Table 1 reports the outcomes.

## References

[1] Smith, J. (2001). Classical widgets. Journal of Widgets, 1(2), 3-14.
[2] Doe, A. (2019). Modern widgets. Widgets Today, 5(1), 1-20.
`;

describe('readMarkdown: blocks and hashes', () => {
  const doc = readMarkdown(SAMPLE_PAPER, 'md', 'sample');

  it('takes the H1 title', () => {
    expect(doc.title).toBe('On the Stability of Widget Networks');
  });

  it('emits title and heading blocks with correct types', () => {
    const types = new Set(doc.blocks.map((b) => b.type));
    expect(types.has(BlockType.TITLE)).toBe(true);
    expect(types.has(BlockType.HEADING)).toBe(true);
  });

  it('computes content hashes like the Python model', () => {
    for (const b of doc.blocks) {
      expect(b.contentHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('assigns sequential ids and orders', () => {
    doc.blocks.forEach((b, i) => {
      expect(b.id).toBe(`b${String(i).padStart(5, '0')}`);
      expect(b.order).toBe(i);
    });
  });
});

describe('readMarkdown: findBlocks', () => {
  const doc = readMarkdown(SAMPLE_PAPER, 'md', 'sample');

  it('finds the exact quote once', () => {
    expect(doc.findBlocks('Every widget network is stable')).toHaveLength(1);
  });

  it('matches case/punctuation/whitespace-insensitively', () => {
    const hits = doc.findBlocks('every  widget  NETWORK is stable.');
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('readMarkdown: sections', () => {
  const doc = readMarkdown(SAMPLE_PAPER, 'md', 'sample');

  it('builds one section per numbered part, title last', () => {
    const titles = doc.sectionTitles();
    expect(titles).toContain('1. Introduction');
    expect(titles).toContain('2. Model');
    expect(titles).toContain('3. Main result');
    expect(titles[titles.length - 1]).toBe('References');
  });

  it('section bounds are contiguous and non-overlapping', () => {
    for (const s of doc.sections) {
      expect(s.endBlock).toBeGreaterThan(s.startBlock);
    }
    for (let i = 1; i < doc.sections.length; i++) {
      expect(doc.sections[i]!.startBlock).toBe(doc.sections[i - 1]!.endBlock);
    }
  });

  it('heading blocks carry their own title as section path', () => {
    const h = doc.blocks.find(
      (b) => b.type === BlockType.HEADING && b.text === '2. Model',
    );
    expect(h?.sectionPath).toEqual(['2. Model']);
  });
});

describe('readMarkdown: references split', () => {
  const doc = readMarkdown(SAMPLE_PAPER, 'md', 'sample');

  it('detects the references section and collects its text', () => {
    expect(doc.referencesText).toBeTruthy();
    expect(doc.referencesText).toContain('Smith');
    expect(doc.referencesText).toContain('Doe');
  });
});

describe('readMarkdown: block classification', () => {
  it('marks abstract paragraphs', () => {
    const doc = readMarkdown('# T\n\nAbstract: We study widgets.\n\nBody text.', 'md');
    expect(doc.blocks.map((b) => b.type)).toContain(BlockType.ABSTRACT);
  });

  it('marks display equations', () => {
    const doc = readMarkdown('# T\n\n$$\nE = mc^2\n$$\n\nBody text.', 'md');
    expect(doc.blocks.map((b) => b.type)).toContain(BlockType.EQUATION);
  });

  it('marks list items (bullet and numbered)', () => {
    const doc = readMarkdown(
      '# T\n\n- first\n\n* second\n\n1. numbered\n\n+ plus',
      'md',
    );
    const listish = doc.blocks.filter((b) => b.type === BlockType.LIST_ITEM);
    expect(listish).toHaveLength(4);
  });

  it('marks fenced code; indented code blocks are stripped to paragraphs (Python parity)', () => {
    const doc = readMarkdown('# T\n\n```\ncode here\n```\n\n    indented code', 'md');
    expect(doc.blocks[1]?.type).toBe(BlockType.CODE);
    // Python strips the para, so leading spaces (and thus the indented-code
    // startswith check) disappear — ported behavior, verified against Python.
    expect(doc.blocks[2]?.type).toBe(BlockType.PARAGRAPH);
  });

  it('marks pipe tables', () => {
    const doc = readMarkdown('# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |', 'md');
    expect(doc.blocks.map((b) => b.type)).toContain(BlockType.TABLE);
  });
});

describe('readMarkdown: multi-line headings are not headings', () => {
  it('a # paragraph spanning lines stays a paragraph', () => {
    const doc = readMarkdown('# Not a heading\nbecause it wraps', 'md');
    expect(doc.blocks.map((b) => b.type)).not.toContain(BlockType.HEADING);
  });
});

describe('unsupportedFormat', () => {
  it('throws UnsupportedFormatError mentioning the extension', () => {
    expect(() => unsupportedFormat('.doc')).toThrow(UnsupportedFormatError);
    try {
      unsupportedFormat('.doc');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedFormatError);
      expect((e as UnsupportedFormatError).message).toContain('Unsupported');
      expect((e as UnsupportedFormatError).message).toContain('.doc');
    }
  });
});
