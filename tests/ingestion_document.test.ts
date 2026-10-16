import { describe, expect, it } from 'vitest';
import {
  Block,
  BlockType,
  Document,
  Section,
  contentHashOf,
  normalizeText,
} from '../src/ingestion/document';
import { sha256Hex } from '../src/ingestion/sha256';

describe('sha256Hex', () => {
  // standard test vectors; full digests must match Python hashlib.sha256(...).hexdigest()
  it('hashes ASCII and UTF-8 input', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('na\u00efve-caf\u00e9')).toBe(
      '7aa270c7a0520b1e633907482ab7048f0e5f0fac1ffc71e63cef30ffb9f4cfa9',
    );
  });
});

describe('normalizeText', () => {
  it('collapses whitespace and strips ends', () => {
    expect(normalizeText('A\tB\n\nC   D ')).toBe('A B C D');
  });

  it('NFKC-normalizes and unifies punctuation', () => {
    // soft hyphen removed, curly quotes -> straight, dashes/minus -> '-'
    expect(normalizeText('x\u00ady\u2013z\u2014w\u22125')).toBe('xy-z-w-5');
    expect(normalizeText('\u2018q\u2019 \u201cd\u201d')).toBe('\'q\' "d"');
    // NFKC: fullwidth letters fold to ASCII
    expect(normalizeText('\uff2f\uff4b')).toBe('Ok');
  });

  it('matches Python reference vectors (normalize + hash)', () => {
    // sha256(normalize_text(s))[:16] computed with the Python implementation
    const vectors: Array<[string, string, string]> = [
      ['', '', 'e3b0c44298fc1c14'],
      [
        'Theorem 1. Every widget network is stable.',
        'Theorem 1. Every widget network is stable.',
        'bb04d256efdfa81e',
      ],
      ['A\tB\n\nC   D ', 'A B C D', 'c3243b5c5a917114'],
      ['na\u00efve\u2014caf\u00e9', 'na\u00efve-caf\u00e9', '7aa270c7a0520b1e'],
      [
        'caf\u00e9 \u2014 \u201ctypes\u201d \u2018quoted\u2019  x\u2013y\u2014z \u22125\u00adabc',
        'caf\u00e9 - "types" \'quoted\' x-y-z -5abc',
        '53ed3510f8ba7397',
      ],
    ];
    for (const [orig, norm, hash] of vectors) {
      expect(normalizeText(orig)).toBe(norm);
      expect(contentHashOf(orig)).toBe(hash);
    }
  });
});

describe('Block', () => {
  it('defaults type, sectionPath, order and auto-computes contentHash', () => {
    const b = new Block({ id: 'b00000', text: 'Hello  world' });
    expect(b.type).toBe(BlockType.PARAGRAPH);
    expect(b.sectionPath).toEqual([]);
    expect(b.order).toBe(0);
    expect(b.page).toBeUndefined();
    expect(b.contentHash).toMatch(/^64ec88ca00b268e5/); // sha256("Hello world")[:16]
  });

  it('keeps an explicitly provided contentHash', () => {
    const b = new Block({ id: 'b00000', text: 'x', contentHash: 'preset' });
    expect(b.contentHash).toBe('preset');
  });
});

describe('Document', () => {
  const doc = new Document({
    title: 'Sample',
    blocks: [
      new Block({ id: 'b00000', text: 'First', order: 0 }),
      new Block({ id: 'b00001', text: 'Second', order: 1, sectionPath: ['Methods'] }),
    ],
    sections: [
      new Section({ path: ['Methods'], title: 'Methods', startBlock: 1, endBlock: 2 }),
    ],
  });

  it('fullText joins block texts with blank lines', () => {
    expect(doc.fullText()).toBe('First\n\nSecond');
  });

  it('findBlocks matches normalized, case-insensitively', () => {
    expect(doc.findBlocks('first')).toHaveLength(1);
    expect(doc.findBlocks('SECOND')).toHaveLength(1);
    expect(doc.findBlocks('   second  ')).toHaveLength(1);
    expect(doc.findBlocks('')).toEqual([]);
    expect(doc.findBlocks('nowhere')).toEqual([]);
  });

  it('sectionTitles lists titles in order', () => {
    expect(doc.sectionTitles()).toEqual(['Methods']);
  });

  it('defaults: title Untitled, sourceFormat md, empty collections', () => {
    const d = new Document({});
    expect(d.title).toBe('Untitled');
    expect(d.sourceFormat).toBe('md');
    expect(d.blocks).toEqual([]);
    expect(d.sections).toEqual([]);
    expect(d.figures).toEqual([]);
    expect(d.tables).toEqual([]);
    expect(d.theorems).toEqual([]);
    expect(d.referencesText).toBeUndefined();
  });
});
