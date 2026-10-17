/**
 * Comment-to-block anchor resolution for report assembly.
 *
 * Port of Python `open_referee/pipeline/orchestrator.py` `_resolve_anchor`
 * and `_section_of_block` (plus the `_norm` helper they share).
 */

import type { Document } from '../ingestion/document';
import { normalizeText } from '../ingestion/document';

function norm(t: string): string {
  return normalizeText(t).toLowerCase();
}

/** Python `round(x, 2)` (half-to-even) on the fraction p/q, via integers. */
function roundHalfEven2(p: number, q: number): number {
  const num = p * 100;
  const den = q;
  const fl = Math.floor(num / den);
  const twice = (num - fl * den) * 2;
  const units = twice > den || (twice === den && fl % 2 === 1) ? fl + 1 : fl;
  return units / 100;
}

/**
 * Fuzzy-resolve a comment to a block. Mirrors Python `_resolve_anchor`:
 * unique anchor hit -> 1.0, multi hit -> 0.7, quote hit -> 0.6, then a
 * token-overlap Jaccard fallback (> 0.35) on the anchor; else no block.
 */
export function resolveAnchor(
  doc: Document,
  anchor: string,
  quote: string,
): { blockId: string | null; confidence: number } {
  if (anchor) {
    const hits = doc.findBlocks(anchor);
    if (hits.length === 1) return { blockId: hits[0]!.id, confidence: 1.0 };
    if (hits.length > 0) return { blockId: hits[0]!.id, confidence: 0.7 };
  }
  if (quote) {
    const hits = doc.findBlocks(quote);
    if (hits.length > 0) return { blockId: hits[0]!.id, confidence: 0.6 };
  }
  if (anchor) {
    // token-overlap fallback
    const aTokens = new Set(norm(anchor).split(' '));
    let best: { id: string } | null = null;
    let bestJ = 0.0;
    for (const b of doc.blocks) {
      const tokens = new Set(norm(b.text).split(' '));
      if (tokens.size === 0) continue;
      let inter = 0;
      for (const t of aTokens) if (tokens.has(t)) inter++;
      const union = aTokens.size + tokens.size - inter;
      const j = inter / Math.max(1, union);
      if (j > bestJ) {
        best = { id: b.id };
        bestJ = j;
      }
    }
    if (best !== null && bestJ > 0.35) {
      return {
        blockId: best.id,
        confidence: roundHalfEven2(Math.round(bestJ * 100), 100),
      };
    }
  }
  return { blockId: null, confidence: 0.0 };
}

/**
 * Python `_section_of_block`: the first segment of the block's section path,
 * or null when the block (or a section path) does not exist.
 */
export function sectionOfBlock(doc: Document, blockId: string | null): string | null {
  if (!blockId) return null;
  for (const b of doc.blocks) {
    if (b.id === blockId) return b.sectionPath[0] ?? null;
  }
  return null;
}
