import { describe, expect, it } from 'vitest';
import {
  COMMENT_SCHEMA,
  REFEREE_PERSONA,
  SEVERITY_RUBRIC,
  bibliographyPrompt,
  bibliographySystem,
  challengerPrompt,
  challengerSystem,
  empiricalVerifierSystem,
  figurePrompt,
  figureSystem,
  litVerifierSystem,
  mathVerifierSystem,
  metaPrompt,
  metaSystem,
  proseVerifierSystem,
  surveySystem,
  triagePrompt,
  triageSystem,
  validatorPrompt,
  validatorSystem,
  verifierPrompt,
  wholePaperChallengerPrompt,
  wholePaperChallengerSystem,
  wholePaperVerifierPrompt,
  wholePaperVerifierSystem,
} from '../src/pipeline/prompts';

// --------------------------------------------------------------- persona --

describe('persona and shared rubric', () => {
  it('persona is present in all stage system prompts', () => {
    for (const p of [
      triageSystem,
      challengerSystem,
      bibliographySystem,
      metaSystem,
      validatorSystem,
      figureSystem,
    ]) {
      expect(p).toContain('top academic journal');
    }
  });

  it('every lens prompt carries persona and comment schema', () => {
    for (const system of [
      mathVerifierSystem,
      empiricalVerifierSystem,
      proseVerifierSystem,
      litVerifierSystem,
    ]) {
      expect(system).toContain('top academic journal');
      expect(system).toContain('STRICT JSON');
      expect(system).toContain('paragraph_anchor');
      expect(system.toLowerCase()).toContain('severity');
    }
  });

  it('severity rubric bands appear in every comment producer', () => {
    for (const p of [
      mathVerifierSystem,
      empiricalVerifierSystem,
      proseVerifierSystem,
      litVerifierSystem,
      figureSystem,
      challengerSystem,
    ]) {
      expect(p).toContain('0.80-1.00');
      expect(p).toContain('0.60-0.79');
      expect(p).toContain('0.35-0.59');
      expect(p).toContain('0.10-0.34');
    }
  });
});

// ------------------------------------------------- per-prompt guarantees --

describe('per-prompt content guarantees (ported from test_prompts.py)', () => {
  it('bibliography prompt covers existence and quotation', () => {
    expect(bibliographySystem).toContain('EXISTENCE');
    expect(bibliographySystem).toContain('QUOTATION CONSISTENCY');
    expect(bibliographySystem).toContain('in_text_issues');
  });

  it('math lens covers statements, proofs and cases', () => {
    for (const needle of [
      'statement',
      'proof',
      'without loss of generality',
      'boundary',
      'notation',
      'circular',
    ]) {
      expect(mathVerifierSystem.toLowerCase()).toContain(needle);
    }
  });

  it('empirical lens covers econometric practice', () => {
    for (const needle of [
      'identification',
      'parallel trends',
      'instrument',
      'clustering',
      'multiple hypothesis',
      'robustness',
      'external validity',
    ]) {
      expect(empiricalVerifierSystem.toLowerCase()).toContain(needle);
    }
  });

  it('meta prompt requires recommendation and strengths', () => {
    expect(metaSystem.toLowerCase()).toContain('strengths');
    expect(metaSystem.toLowerCase()).toContain('recommendation');
    expect(metaSystem).toContain('major revision');
  });

  it('validator prompt drops unsubstantiated comments', () => {
    expect(validatorSystem).toContain('DROP');
    expect(validatorSystem).toContain('fabricated');
  });

  it('whole-paper verifier prompt has the right scope', () => {
    expect(wholePaperVerifierSystem).toContain('ENTIRE manuscript');
    for (const needle of [
      'abstract',
      'contribution',
      'notation',
      'results',
      'conclusion',
      'cross-section',
    ]) {
      expect(wholePaperVerifierSystem.toLowerCase()).toContain(needle);
    }
    expect(wholePaperVerifierSystem).toContain('top academic journal');
    expect(wholePaperVerifierSystem).toContain('paragraph_anchor');
  });

  it('whole-paper challenger validates and hunts', () => {
    expect(wholePaperChallengerSystem.toLowerCase()).toContain('validate');
    expect(wholePaperChallengerSystem).toContain('GLOBAL');
    expect(wholePaperChallengerSystem).toContain('overclaiming');
    expect(wholePaperChallengerSystem).toContain('verdict');
  });

  it('survey prompt asks for STRICT JSON selection output', () => {
    expect(surveySystem).toContain('STRICT JSON');
    expect(surveySystem).toContain('state_of_the_art_notes');
    expect(surveySystem).toContain('missing_references');
  });
});

// ------------------------------------------------------ placeholder subs --

describe('user-prompt builders substitute every placeholder', () => {
  it('leaves no unreplaced {placeholder} in any builder output', () => {
    const outputs = [
      triagePrompt('T', 'M'),
      verifierPrompt('S', 'C', 'X'),
      wholePaperVerifierPrompt('T', 'M'),
      wholePaperChallengerPrompt('T', 'M', '[]'),
      challengerPrompt('S', 'C', 'X', '[]'),
      bibliographyPrompt('R', 'I', 'RES', 'P'),
      metaPrompt('T', '{}', '[]', 'B', 'N'),
      validatorPrompt('T', 'M', '[]', 'O'),
      figurePrompt('T', 3, 'C'),
    ];
    for (const out of outputs) {
      // JSON examples in the prompts use {"key": ...} — a bare {word} must not remain
      expect(out).not.toMatch(/\{[a-z_][a-z_0-9]*\}/);
    }
  });

  it('inserts each argument at its placeholder', () => {
    expect(triagePrompt('MY-TITLE', 'MY-TEXT')).toContain('Manuscript title: MY-TITLE');
    expect(triagePrompt('MY-TITLE', 'MY-TEXT')).toContain('---\nMY-TEXT\n---');

    const v = verifierPrompt('SEC', 'CTX', 'BODY');
    expect(v).toContain('Section: SEC');
    expect(v).toContain('CTX');
    expect(v).toContain('---\nBODY\n---');

    const c = challengerPrompt('SEC', 'CTX', 'BODY', 'CANDS');
    expect(c).toContain('Candidate comments (JSON):\nCANDS');

    const m = metaPrompt('T', 'TRI', 'COM', 'BIB', 'SOTA');
    expect(m).toContain('Triage: TRI');
    expect(m).toContain('Citation audit summary: BIB');
    expect(m).toContain('Literature notes: SOTA');

    const f = figurePrompt('PAPER', 7, 'CONTEXT7');
    expect(f).toContain('Figure from paper "PAPER" (page 7).');
  });
});

// ------------------------------------------------- character identity -----

describe('character-identity spot checks vs the Python source', () => {
  it('SEVERITY_RUBRIC is character-identical to Python', () => {
    expect(SEVERITY_RUBRIC).toBe(
      'Severity rubric: 0.80-1.00 invalidates a result/claim as stated; ' +
        '0.60-0.79 major (undermines part of a main claim, must fix before publication); ' +
        '0.35-0.59 minor but required; 0.10-0.34 polish/clarity.',
    );
  });

  it('persona distinctive substrings appear verbatim', () => {
    expect(REFEREE_PERSONA).toContain(
      "You are a referee for a top academic journal in the paper's field.",
    );
    expect(REFEREE_PERSONA).toContain(
      'If you cannot point to the exact sentence, equation, table, or citation ' +
        'that is problematic, do not raise the point.',
    );
    expect(REFEREE_PERSONA).toContain(
      'Calibrate severity honestly: 0.8+ only for flaws that invalidate a result ' +
        'as stated; do not inflate.',
    );
  });

  it('comment schema distinctive substrings appear verbatim', () => {
    expect(COMMENT_SCHEMA).toContain(
      '"paragraph_anchor": "verbatim sentence from the section',
    );
    expect(COMMENT_SCHEMA).toContain(
      'math|consistency|evidence|references|clarity|novelty|statistical|other',
    );
    expect(COMMENT_SCHEMA).toContain(
      'If you find nothing that meets the bar, return {"comments": []}.',
    );
  });

  it('math lens mandate line appears verbatim', () => {
    expect(mathVerifierSystem).toContain(
      'You are the MATHEMATICS AND THEORY REFEREE. Your mandate: verify the mathematical ' +
        'and theoretical content of this section — equations, definitions, lemmas, theorems, ' +
        'propositions, proofs.',
    );
  });

  it('whole-paper challenger JSON keys appear verbatim', () => {
    expect(wholePaperChallengerSystem).toContain(
      '"verdict": "kept|adjusted|dropped", "verdict_reason": "one sentence"',
    );
  });

  it('triage user template joins title and manuscript exactly like Python', () => {
    expect(triagePrompt('Widget Paper', 'Full text here')).toBe(
      'Manuscript title: Widget Paper\n\n' +
        'Manuscript (may be truncated):\n' +
        '---\n' +
        'Full text here\n' +
        '---',
    );
  });

  it('validator user template matches Python layout', () => {
    expect(validatorPrompt('T', 'M', 'C', 'O')).toBe(
      'Manuscript title: T\n\n' +
        'Manuscript (truncated):\n' +
        '---\n' +
        'M\n' +
        '---\n\n' +
        'Draft review comments (JSON):\n' +
        'C\n\n' +
        'Draft overall feedback (markdown):\n' +
        '---\n' +
        'O\n' +
        '---',
    );
  });
});
