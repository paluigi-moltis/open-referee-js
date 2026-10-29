/**
 * Markdown rendering of the review report.
 *
 * Port of the markdown path of Python `open_referee/report/render.py`
 * (`render_markdown`), structure-faithful to the Python output.
 */

import type { ReviewReport } from './models';
import { sortedComments } from './models';

function utcTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm} UTC`;
}

/** Python `render_markdown`, character-faithful in structure. */
export function reportToMarkdown(report: ReviewReport): string {
  const parts: string[] = [`# Review report — ${report.paperTitle}`, ''];
  parts.push(`_Generated ${utcTimestamp(report.generatedAt)}_`);
  if (report.recommendation) {
    parts.push(`_Recommendation — ${report.recommendation}_`);
  }
  if (report.partial) {
    parts.push('_PARTIAL REPORT: the run stopped early; sections may be missing._');
  }
  parts.push('', '## Overall feedback', '', report.overall || '_(none)_', '');

  parts.push(`## Detailed comments (${report.comments.length})`, '');
  for (const [i, c] of sortedComments(report).entries()) {
    const sev = `[severity ${c.severity.toFixed(2)}]`;
    const sec = c.section ? ` — _${c.section}_` : '';
    parts.push(`### ${i + 1}. ${c.id ? `${c.id} ` : ''}Comment ${sev}${sec}`.trimEnd());
    if (c.quote) {
      parts.push('', `> ${c.quote}`);
    }
    parts.push('', c.comment, '');
  }
  // Python order: findings -> validator notes -> copyedit table -> usage.
  if (report.copyeditItems && report.copyeditItems.length > 0) {
    parts.push(
      `## Suggested language fixes (${report.copyeditItems.length})`,
      '',
      '_Mechanical language items from the copyedit pass — typos, grammar, ' +
        'phrasing, terminology. Each quote is verified to appear in the ' +
        'manuscript; these are copyedits, not findings, and carry no ' +
        'severity._',
      '',
      '| # | Kind | Location | Original | Suggested fix |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const [i, it] of report.copyeditItems.entries()) {
      const q = it.quote.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const s = it.suggestion.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      parts.push(`| ${i + 1} | ${it.kind} | ${it.section || '—'} | ${q} | ${s} |`);
    }
    parts.push('');
  }
  const u = report.usage;
  if (u.estimatedCostUsd || u.totalPromptTokens) {
    parts.push(
      '## Usage',
      '',
      `Input tokens: ${u.totalPromptTokens.toLocaleString('en-US')} · Output tokens: ` +
        `${u.totalCompletionTokens.toLocaleString('en-US')} · ` +
        `Estimated cost: $${u.estimatedCostUsd.toFixed(4)}`,
      '',
    );
  }
  return parts.join('\n');
}
