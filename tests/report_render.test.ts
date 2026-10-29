import { describe, expect, it } from 'vitest';
import { reportToMarkdown } from '../src/report/render';
import type { ReviewComment, ReviewReport } from '../src/report/models';
import { sortedComments } from '../src/report/models';

function comment(partial: Partial<ReviewComment>): ReviewComment {
  return {
    section: 'Section 1',
    quote: 'quoted text',
    comment: 'what is wrong and why',
    severity: 0.5,
    ...partial,
  };
}

function report(partial: Partial<ReviewReport> = {}): ReviewReport {
  return {
    paperTitle: 'Test Paper',
    overall: '## Weaknesses\n\nThe proof of Lemma 2 is incomplete.',
    comments: [],
    usage: {
      byRole: {},
      estimatedCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    },
    partial: false,
    generatedAt: '2026-10-16T14:00:00.000Z',
    ...partial,
  };
}

describe('sortedComments', () => {
  it('sorts by severity descending without mutating the input', () => {
    const r = report({
      comments: [
        comment({ severity: 0.2 }),
        comment({ severity: 0.9 }),
        comment({ severity: 0.6 }),
      ],
    });
    const sorted = sortedComments(r);
    expect(sorted.map((c) => c.severity)).toEqual([0.9, 0.6, 0.2]);
    expect(r.comments.map((c) => c.severity)).toEqual([0.2, 0.9, 0.6]);
  });
});

describe('reportToMarkdown', () => {
  it('renders the Python render_markdown structure', () => {
    const md = reportToMarkdown(
      report({
        comments: [
          comment({
            severity: 0.85,
            section: 'Section 3',
            quote: 'the span',
            comment: 'broken',
          }),
          comment({ severity: 0.3, quote: '', section: '' }),
        ],
        usage: {
          byRole: {},
          estimatedCostUsd: 0.0123,
          totalPromptTokens: 12000,
          totalCompletionTokens: 3400,
        },
      }),
    );
    const lines = md.split('\n');
    expect(lines[0]).toBe('# Review report — Test Paper');
    expect(md).toContain('_Generated 2026-10-16 14:00 UTC_');
    expect(md).toContain('## Overall feedback');
    expect(md).toContain('The proof of Lemma 2 is incomplete.');
    expect(md).toContain('## Detailed comments (2)');
    // highest severity first, severity formatted to 2 decimals
    expect(md).toMatch(/### 1\. .* \[severity 0\.85\] — _Section 3_/);
    expect(md).toContain('> the span');
    expect(md).toMatch(/^### 2\. Comment \[severity 0\.30\]$/m);
    expect(md).toContain(
      'Input tokens: 12,000 · Output tokens: 3,400 · Estimated cost: $0.0123',
    );
    // no usage section when usage is empty
    const empty = reportToMarkdown(report());
    expect(empty).not.toContain('## Usage');
  });

  it('renders the recommendation when present and omits it otherwise', () => {
    expect(reportToMarkdown(report({ recommendation: 'major revision' }))).toContain(
      '_Recommendation — major revision_',
    );
    expect(reportToMarkdown(report())).not.toContain('Recommendation');
  });

  it('marks partial reports', () => {
    expect(reportToMarkdown(report({ partial: true }))).toContain('PARTIAL REPORT');
    expect(reportToMarkdown(report())).not.toContain('PARTIAL REPORT');
  });

  it('renders the copyedit annex exactly as Python render.py', () => {
    const md = reportToMarkdown(
      report({
        copyeditItems: [
          {
            quote: 'bootstrap with 999 replications',
            suggestion: 'bootstrap with 1,000 replications',
            kind: 'grammar',
            section: 'Methods',
          },
          {
            quote: 'pipe | and\nnewline',
            suggestion: 'cleaned',
            kind: 'typo',
            section: null,
          },
        ],
      }),
    );
    expect(md).toContain('## Suggested language fixes (2)');
    expect(md).toContain(
      '_Mechanical language items from the copyedit pass — typos, grammar, ' +
        'phrasing, terminology. Each quote is verified to appear in the ' +
        'manuscript; these are copyedits, not findings, and carry no ' +
        'severity._',
    );
    expect(md).toContain('| # | Kind | Location | Original | Suggested fix |');
    expect(md).toContain('| --- | --- | --- | --- | --- |');
    expect(md).toContain(
      '| 1 | grammar | Methods | bootstrap with 999 replications | ' +
        'bootstrap with 1,000 replications |',
    );
    // pipe and newline escaped in cells; null section falls back to '—'
    expect(md).toContain('| 2 | typo | — | pipe \\| and newline | cleaned |');
    // no section when there are no items
    expect(reportToMarkdown(report())).not.toContain('Suggested language fixes');
  });

  it('falls back to _(none)_ for empty overall text', () => {
    expect(reportToMarkdown(report({ overall: '' }))).toContain('_(none)_');
  });
});
