/**
 * PDF format reader.
 *
 * Port of Python `open_referee/ingestion/readers.py::_ingest_pdf` (L156-211)
 * on top of pdf.js instead of pymupdf.
 *
 * Text extraction: pdf.js `getTextContent()` yields one item per text-show
 * operation; pymupdf's `get_text('text')` yields newline-delimited LINES.
 * We join items into lines by baseline y (the transform's ty, page space):
 * items whose baseline y is within a small epsilon form one line, ordered by
 * x; different baselines become separate lines. This reproduces pymupdf's
 * line-per-bbox-y output for the fixture layout (one Tj per visual line).
 *
 * Deviations from Python (documented, owner decision 4 allows heuristic-only
 * v1):
 * - figures: NOT extracted — pymupdf decodes embedded image xrefs; decoding
 *   arbitrary embedded images (JPEG2000/CMYK/masks) via pdf.js in the
 *   browser is a canvas-path rabbit hole. `figures = []` for v1.
 * - tables: pymupdf `find_tables()` has no pdf.js equivalent; a heuristic
 *   clusterer detects column-aligned numeric/text grids from text-item x
 *   positions (>= 2 cols x >= 2 rows) and emits TableArtifacts with markdown
 *   produced by the SAME `_table_to_markdown` escaping as Python. No
 *   page-region image (browser canvas render is a v2 concern).
 *
 * pdfjs-dist is dynamic-imported (legacy build, no worker in tests) so it
 * stays out of the main browser bundle.
 */

import type { Document as RefereeDocument, TableArtifact } from './document';
import { documentFromMarkdown } from './readers_md';
import { pdfTextToMarkdown } from './pdf_text';

/** Baselines closer than this (PDF units) are the same visual line. */
const LINE_EPSILON = 2.5;

interface TextItemLike {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

export type { TextItemLike };

/**
 * Join pdf.js text items into pymupdf-'text'-style lines: line per baseline
 * y (items sorted by x within a line, lines ordered top-to-bottom).
 */
export function pdfItemsToLines(items: TextItemLike[]): string[] {
  const real = items.filter((it) => it.str && it.str.length > 0);
  const rows: { y: number; x: number; str: string }[] = real.map((it) => ({
    y: it.transform[5] ?? 0,
    x: it.transform[4] ?? 0,
    str: it.str,
  }));
  rows.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: string[] = [];
  let cur: { y: number; parts: { x: number; str: string }[] } | null = null;
  const flush = (): void => {
    if (cur) {
      lines.push(cur.parts.map((p) => p.str).join(''));
    }
  };
  for (const r of rows) {
    if (cur && Math.abs(r.y - cur.y) <= LINE_EPSILON) {
      cur.parts.push(r);
    } else {
      flush();
      cur = { y: r.y, parts: [r] };
    }
  }
  flush();
  return lines;
}

/** Python `_table_to_markdown` (readers.py L308-319): cell matrix -> markdown. */
export function tableToMarkdown(cells: (string | null)[][]): string {
  if (cells.length === 0) return '';
  const rows = cells.map((row) => {
    const vals = row.map((c) =>
      c === null ? '' : String(c).replace(/\n/g, ' ').replace(/\|/g, '\\-'),
    );
    return '| ' + vals.join(' | ') + ' |';
  });
  const nCols = rows[0]!.split('|').length - 2;
  rows.splice(1, 0, '|' + '---|'.repeat(nCols));
  return rows.join('\n');
}

interface Cell {
  x: number;
  y: number;
  str: string;
}

/**
 * Heuristic table clusterer: group text items into grid rows by baseline
 * y-cluster; a row is a table row when >= 2 items share (within tolerance)
 * x positions with items in other rows. Emits cell text per (row, column).
 * Returns [] when no aligned grid is found.
 */
export function detectTables(items: TextItemLike[]): (string | null)[][][] {
  const real = items.filter((it) => it.str && it.str.trim().length > 0);
  if (real.length < 4) return [];
  const cells: Cell[] = real.map((it) => ({
    x: it.transform[4] ?? 0,
    y: it.transform[5] ?? 0,
    str: it.str.trim(),
  }));
  // cluster rows by y
  cells.sort((a, b) => b.y - a.y);
  const rows: Cell[][] = [];
  for (const c of cells) {
    const row = rows.find((r) => Math.abs(r[0]!.y - c.y) <= LINE_EPSILON);
    if (row) row.push(c);
    else rows.push([c]);
  }
  // need >= 3 rows to form a table (header + separator logic needs >= 2
  // content rows; a lone pair is usually just two aligned paragraphs)
  if (rows.length < 3) return [];
  // cluster columns by x across all rows
  const xTolerance = 10;
  const colXs: number[] = [];
  for (const row of rows) {
    for (const c of row) {
      if (!colXs.some((x) => Math.abs(x - c.x) <= xTolerance)) {
        colXs.push(c.x);
      }
    }
  }
  colXs.sort((a, b) => a - b);
  if (colXs.length < 2) return [];
  // build the cell matrix; a "table row" must span >= 2 columns
  const matrix: (string | null)[][] = [];
  for (const row of rows) {
    const gridRow: (string | null)[] = new Array(colXs.length).fill(null);
    let filled = 0;
    for (const c of row) {
      let best = -1;
      let bestDist = Infinity;
      colXs.forEach((x, i) => {
        const d = Math.abs(x - c.x);
        if (d <= xTolerance && d < bestDist) {
          best = i;
          bestDist = d;
        }
      });
      if (best >= 0 && gridRow[best] === null) {
        gridRow[best] = c.str;
        filled += 1;
      }
    }
    if (filled >= 2) matrix.push(gridRow);
  }
  // >= 2 columns x >= 2 rows
  const width = matrix.reduce(
    (m, r) => Math.max(m, r.filter((c) => c !== null).length),
    0,
  );
  if (matrix.length < 2 || width < 2) return [];
  return [matrix];
}

/**
 * Python `_ingest_pdf`: per-page text -> `_pdf_text_to_markdown` ->
 * `document_from_markdown`, with figures/tables attached and a proportional
 * block->page mapping (readers.py L209-210, exact).
 */
export async function documentFromPdf(
  data: ArrayBuffer | Uint8Array,
  titleHint = '',
): Promise<RefereeDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const doc = await loadingTask.promise;

  const lines: string[] = [];
  const tables: TableArtifact[] = [];
  const figures: RefereeDocument['figures'] = [];
  const nPages = doc.numPages;
  for (let pno = 1; pno <= nPages; pno++) {
    const page = await doc.getPage(pno);
    const tc = await page.getTextContent();
    // TextItem (has .str) vs TextMarkedContent — narrow structurally.
    const items: TextItemLike[] = tc.items.flatMap((it) =>
      typeof (it as TextItemLike).str === 'string' &&
      Array.isArray((it as TextItemLike).transform)
        ? [it as unknown as TextItemLike]
        : [],
    );
    lines.push(pdfItemsToLines(items).join('\n'));
    // heuristic table detection (no pymupdf find_tables equivalent)
    try {
      const found = detectTables(items);
      for (let ti = 0; ti < found.length; ti++) {
        tables.push({
          id: `tbl_p${pno}_${ti + 1}`,
          page: pno,
          markdown: tableToMarkdown(found[ti]!),
        });
      }
    } catch {
      // table detection is best-effort; never block ingestion
    }
    // figures: deferred — see module docblock (v1 deviation)
    page.cleanup();
  }
  await loadingTask.destroy();

  const raw = lines.join('\n');
  const md = pdfTextToMarkdown(raw);
  const d = documentFromMarkdown(md, 'pdf', titleHint);
  d.figures = figures;
  d.tables = tables;
  // approximate block->page mapping by proportional position (Python L209-210)
  for (const b of d.blocks) {
    (b as { page?: number }).page = Math.max(
      1,
      Math.min(
        nPages,
        1 + Math.trunc((b.order * nPages) / Math.max(1, d.blocks.length)),
      ),
    );
  }
  return d;
}
