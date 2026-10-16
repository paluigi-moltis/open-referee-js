/**
 * Open Referee browser UI (Stage 1): settings panel, file ingest, run
 * progress, and the rendered report. Vanilla TS DOM, no framework.
 *
 * API key policy: the key lives in a module-level variable for the session
 * ONLY — it is never passed to saveSettings (which strips keys anyway) and
 * never persisted anywhere.
 */

import { loadSettings, saveSettings } from '../config/storage';
import type { AppSettings } from '../config/schema';
import { readMarkdown } from '../ingestion/readers_md';
import { OpenAICompatibleProvider } from '../providers/openai';
import { RateLimiter } from '../providers/rate_limit';
import type { ChatProvider } from '../providers/base';
import { runReview } from '../pipeline/orchestrator';
import type { RunState } from '../pipeline/state';
import type { ReviewReport } from '../report/models';
import { reportToMarkdown } from '../report/render';
import { ProgressController } from './progress';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Session-only API key. Never written to storage. */
let sessionApiKey = '';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v);
  }
  for (const c of children) {
    e.append(c);
  }
  return e;
}

function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }));
}

// ----------------------------------------------------------------- settings --

function settingsPanel(settings: AppSettings, onChange: () => void): HTMLElement {
  const fieldset = el('fieldset', { id: 'settings-panel' });
  fieldset.appendChild(el('legend', {}, 'Settings'));

  const strong = el('input', {
    type: 'text',
    id: 'strong-model',
    placeholder: 'strong model name',
    value: settings.roles.strong.model,
  });
  const small = el('input', {
    type: 'text',
    id: 'small-model',
    placeholder: 'small model name (reserved for later stages)',
    value: settings.roles.small.model,
  });
  const baseUrl = el('input', {
    type: 'url',
    id: 'base-url',
    placeholder: 'https://api.openai.com/v1',
    value: settings.providers['default']?.baseUrl ?? '',
  });
  const apiKey = el('input', {
    type: 'password',
    id: 'api-key',
    placeholder: 'API key (this session only, never saved)',
    autocomplete: 'off',
  });
  apiKey.addEventListener('input', () => {
    sessionApiKey = apiKey.value;
  });

  const persist = () => {
    settings.roles.strong.model = strong.value.trim();
    settings.roles.small.model = small.value.trim();
    settings.providers['default'] = {
      type: 'openai_compatible',
      ...(baseUrl.value.trim() ? { baseUrl: baseUrl.value.trim() } : {}),
    };
    // NOTE: apiKey intentionally not stored in settings.
    saveSettings(settings);
    onChange();
  };
  for (const input of [strong, small, baseUrl]) {
    input.addEventListener('change', persist);
  }

  const row1 = el('div', { class: 'row' }, el('label', {}, 'Strong model', strong));
  const row2 = el('div', { class: 'row' }, el('label', {}, 'Small model', small));
  const row3 = el('div', { class: 'row' }, el('label', {}, 'Base URL', baseUrl));
  const row4 = el('div', { class: 'row' }, el('label', {}, 'API key', apiKey));
  fieldset.append(row1, row2, row3, row4);
  return fieldset;
}

// -------------------------------------------------------------------- report --

function reportView(report: ReviewReport, runState: RunState): HTMLElement {
  const wrap = el('section', { id: 'report-view' });
  const overall = el('div', { class: 'report-overall' });
  overall.innerHTML = renderMarkdown(report.overall);
  wrap.appendChild(overall);

  if (report.comments.length > 0) {
    const list = el('ol', { class: 'comment-list' });
    const sorted = [...report.comments].sort((a, b) => b.severity - a.severity);
    for (const c of sorted) {
      const li = el(
        'li',
        {},
        el('strong', {}, ` [${c.severity.toFixed(2)}] `),
        c.section ? el('em', {}, `${c.section} — `) : document.createTextNode(''),
        c.quote ? el('blockquote', {}, c.quote) : document.createTextNode(''),
        el('p', {}, c.comment),
      );
      list.appendChild(li);
    }
    wrap.appendChild(el('h2', {}, `Detailed comments (${report.comments.length})`));
    wrap.appendChild(list);
  }

  const meta = el(
    'p',
    { class: 'report-meta' },
    `Usage: ${report.usage.totalPromptTokens.toLocaleString('en-US')} in / ` +
      `${report.usage.totalCompletionTokens.toLocaleString('en-US')} out · ` +
      `estimated $${report.usage.estimatedCostUsd.toFixed(4)}` +
      (report.partial ? ' · PARTIAL RUN' : ''),
  );
  wrap.appendChild(meta);

  const download = el('button', { type: 'button', id: 'download-md' }, 'Download .md');
  download.addEventListener('click', () => {
    const md = reportToMarkdown(report);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `review-${runState.runId}.md` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
  wrap.appendChild(download);
  return wrap;
}

// --------------------------------------------------------------------- mount --

export function mountApp(root: HTMLElement): void {
  const settings = loadSettings();

  const heading = el('h1', {}, 'Open Referee');
  const runBtn = el(
    'button',
    { type: 'button', id: 'run-btn', disabled: '' },
    'Run review',
  );
  const fileInput = el('input', {
    type: 'file',
    id: 'file-input',
    accept: '.md,.markdown,.txt',
  });
  const fileName = el('span', { id: 'file-name' }, 'no file selected');
  const progressRoot = el('div', { id: 'progress-root' });
  const output = el('div', { id: 'output' });
  const errorBox = el('p', { id: 'error-box', class: 'error', hidden: '' });

  let doc: ReturnType<typeof readMarkdown> | null = null;

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    fileName.textContent = f.name;
    f.text()
      .then((text) => {
        doc = readMarkdown(text, 'md', f.name.replace(/\.(md|markdown|txt)$/i, ''));
        errorBox.hidden = true;
        runBtn.removeAttribute('disabled');
      })
      .catch((err: unknown) => {
        errorBox.textContent = `Failed to read file: ${err instanceof Error ? err.message : String(err)}`;
        errorBox.hidden = false;
      });
  });

  runBtn.addEventListener('click', () => {
    if (!doc) return;
    const baseUrl = settings.providers['default']?.baseUrl;
    if (!baseUrl) {
      errorBox.textContent = 'Set the base URL in settings first.';
      errorBox.hidden = false;
      return;
    }
    if (!sessionApiKey) {
      errorBox.textContent = 'Enter your API key in settings first.';
      errorBox.hidden = false;
      return;
    }
    if (!settings.roles.strong.model) {
      errorBox.textContent = 'Set the strong model name in settings first.';
      errorBox.hidden = false;
      return;
    }
    errorBox.hidden = true;
    output.replaceChildren();
    runBtn.setAttribute('disabled', '');

    const rateLimiter = new RateLimiter(settings.minDelayS);
    const makeProvider = (): ChatProvider =>
      new OpenAICompatibleProvider({
        baseUrl,
        apiKey: sessionApiKey,
        rateLimiter,
        maxRetries: settings.maxRetries,
        timeoutS: settings.requestTimeoutS,
      });
    const providers = { strong: makeProvider(), small: makeProvider() };
    const progress = new ProgressController(progressRoot);

    (async () => {
      const gen = runReview({
        doc,
        settings,
        providers,
        onEvent: (e, p) => progress.onEvent(e, p),
      });
      let state: RunState | undefined;
      for (;;) {
        const next = await gen.next();
        if (next.done) {
          state = next.value;
          break;
        }
      }
      progress.finish(
        state?.partial
          ? 'Run finished (partial report)'
          : 'Run finished — report ready',
      );
      let report: ReviewReport | undefined;
      if (state && state.report !== undefined && typeof state.report === 'object') {
        report = state.report as ReviewReport;
      }
      if (report && state) {
        output.replaceChildren(reportView(report, state));
      }
    })()
      .catch((err: unknown) => {
        errorBox.textContent = `Run failed: ${err instanceof Error ? err.message : String(err)}`;
        errorBox.hidden = false;
      })
      .finally(() => {
        runBtn.removeAttribute('disabled');
        for (const p of Object.values(providers)) p.close();
      });
  });

  root.replaceChildren(
    heading,
    settingsPanel(settings, () => {
      /* settings persisted on change; nothing else to refresh yet */
    }),
    el('div', { class: 'row' }, fileInput, fileName),
    runBtn,
    progressRoot,
    errorBox,
    output,
  );
}
