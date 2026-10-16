/**
 * Robust JSON extraction from LLM responses.
 *
 * Models wrap their JSON in code fences, lead-in prose, and trailing
 * chatter. This module finds the first JSON object or array in a string;
 * anything else raises LLMError so the orchestrator can fail the stage
 * gracefully instead of crashing the run.
 */

import { LLMError } from '../providers/base';

/** True when ch is not whitespace and not a JSON structural character. */
function isProse(ch: string): boolean {
  return !/\s/.test(ch) && ch !== '{' && ch !== '[' && ch !== '}' && ch !== ']';
}

/**
 * Scan s starting at `start` for a balanced {...} or [...] value, honoring
 * string literals (escapes included). Returns the parsed value, or undefined
 * when no complete value is found.
 */
function scanBalanced(s: string, start: number): unknown {
  const open = s[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        try {
          return JSON.parse(slice) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Extract the first JSON object or array from a model response.
 *
 * Order of attempts:
 * 1. the first fenced code block (```json ... ``` or bare ``` fence);
 * 2. a brace/bracket scan that skips prose, strings, and decoy brackets;
 * 3. the whole trimmed string.
 *
 * Throws LLMError('invalid JSON in model response') when nothing parses.
 */
export function extractJson(text: string): unknown {
  // 1. fenced block: parse the body between the first fence pair.
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(text);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim()) as unknown;
    } catch {
      // fall through to the scan
    }
  }

  // 2. balanced-brace scan from the first structural character.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== '{' && ch !== '[') continue;
    const candidate = scanBalanced(text, i);
    if (candidate !== undefined) return candidate;
    // A failed parse at this position: skip past it only if it is inside
    // prose (i.e. we are not on a structural opener that simply truncated).
    if (
      isProse(text.slice(Math.max(0, i - 1), i + 2)[0] ?? ch) === false &&
      ch === '{'
    ) {
      // potential real JSON that failed to parse; do not keep scanning
      // deep into it — but a later opener may still be valid, so continue.
    }
  }

  // 3. whole-string parse.
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    throw new LLMError('invalid JSON in model response');
  }
}
