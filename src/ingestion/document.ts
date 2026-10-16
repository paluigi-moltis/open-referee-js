/**
 * Canonical document model with anchored blocks.
 *
 * Port of Python `open_referee/ingestion/document.py` (field names in
 * camelCase; pydantic models become classes with defaults + the same
 * model_post_init normalization the Python model performs).
 */

import { sha256Hex } from './sha256';

export enum BlockType {
  TITLE = 'title',
  PARAGRAPH = 'paragraph',
  HEADING = 'heading',
  EQUATION = 'equation',
  TABLE = 'table',
  CAPTION = 'caption',
  LIST_ITEM = 'list_item',
  CODE = 'code',
  ABSTRACT = 'abstract',
}

export interface BlockInit {
  id: string;
  type?: BlockType;
  text: string;
  sectionPath?: string[];
  order?: number;
  contentHash?: string;
  page?: number;
}

export class Block {
  readonly id: string;
  readonly type: BlockType;
  readonly text: string;
  /** e.g. ["3", "Methods"] */
  readonly sectionPath: string[];
  readonly order: number;
  readonly contentHash: string;
  /** 1-based PDF page, when known */
  readonly page: number | undefined;

  constructor(init: BlockInit) {
    const { id, text, contentHash, ...rest } = init;
    this.id = id;
    this.text = text;
    this.type = rest.type ?? BlockType.PARAGRAPH;
    this.sectionPath = rest.sectionPath ?? [];
    this.order = rest.order ?? 0;
    this.contentHash = contentHash || contentHashOf(text);
    this.page = rest.page;
  }
}

export interface Figure {
  id: string;
  page?: number;
  imageDataUrl?: string;
  caption?: string;
  captionBlockId?: string;
}

/** A table extracted for dedicated verification (text + optional image). */
export interface TableArtifact {
  id: string;
  page?: number;
  /** parsed cell content, when extraction worked */
  markdown?: string;
  /** page-region render for the vision role */
  imageDataUrl?: string;
  caption?: string;
  captionBlockId?: string;
}

/**
 * A theorem/lemma/proposition/definition/corollary with optional proof.
 *
 * Isolated so the math verifiers see the statement, its proof, and ONLY the
 * definitions it uses — not the whole section.
 */
export interface TheoremEnvironment {
  /** theorem | lemma | proposition | corollary | definition */
  kind: string;
  /** "Theorem 1", "Lemma 2.3" */
  label?: string;
  statement: string;
  proof?: string;
  statementBlockId?: string;
  proofBlockId?: string;
}

export interface SectionInit {
  path: string[];
  title: string;
  startBlock: number;
  /** exclusive */
  endBlock: number;
}

export class Section {
  path: string[];
  title: string;
  startBlock: number;
  /** exclusive */
  endBlock: number;

  constructor(init: SectionInit) {
    this.path = init.path;
    this.title = init.title;
    this.startBlock = init.startBlock;
    this.endBlock = init.endBlock;
  }
}

export interface DocumentInit {
  title?: string;
  sourceFormat?: string;
  blocks?: Block[];
  sections?: Section[];
  figures?: Figure[];
  tables?: TableArtifact[];
  theorems?: TheoremEnvironment[];
  referencesText?: string;
}

export class Document {
  title: string;
  sourceFormat: string;
  blocks: Block[];
  sections: Section[];
  figures: Figure[];
  tables: TableArtifact[];
  theorems: TheoremEnvironment[];
  /** raw bibliography section text if detected */
  referencesText: string | undefined;

  constructor(init: DocumentInit = {}) {
    this.title = init.title ?? 'Untitled';
    this.sourceFormat = init.sourceFormat ?? 'md';
    this.blocks = init.blocks ?? [];
    this.sections = init.sections ?? [];
    this.figures = init.figures ?? [];
    this.tables = init.tables ?? [];
    this.theorems = init.theorems ?? [];
    this.referencesText = init.referencesText;
  }

  fullText(): string {
    return this.blocks.map((b) => b.text).join('\n\n');
  }

  /** Blocks whose normalized text contains the normalized quote (case-insensitive). */
  findBlocks(quote: string): Block[] {
    const q = normalizeText(quote).toLowerCase();
    if (!q) return [];
    return this.blocks.filter((b) => normalizeText(b.text).toLowerCase().includes(q));
  }

  sectionTitles(): string[] {
    return this.sections.map((s) => s.title);
  }
}

/** Short 16-hex-char content hash, identical to the Python implementation. */
export function contentHashOf(text: string): string {
  return sha256Hex(normalizeText(text)).slice(0, 16);
}

/** NFKC-normalize, unify whitespace/hyphens/quotes: robust for anchor matching. */
export function normalizeText(t: string): string {
  let out = t.normalize('NFKC');
  out = out.replace(/\u00ad/g, ''); // soft hyphen
  out = out
    .replace(/\u2018/g, "'")
    .replace(/\u2019/g, "'")
    .replace(/\u201c/g, '"')
    .replace(/\u201d/g, '"')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/\u2212/g, '-');
  return out.replace(/\s+/g, ' ').trim();
}
