// A fully set-up repo for the tests: labels, checks, the report and verdict
// extractors and label buttons, the way a team would configure its own.
import { DEFAULT_CONFIG, NEW_REPO_PROFILE } from '../lib.js';

export const REPO = 'acme/widgets';

export const PROFILE = {
  labels: [
    { name: 'QA failed', kind: 'alert', notify: true },
    { name: 'QA error', kind: 'alert', notify: true },
    { name: 'QA passed', kind: 'ok', notify: true },
    { name: 'qa-requested', kind: 'pending' },
    { name: 'ai-review', kind: 'pending' },
    { name: 'no-qa', kind: 'info' },
  ],
  checks: [
    { label: 'CI', match: '^CI Success$', notify: true },
    { label: 'Preview', match: '^preview / deploy$', notify: true },
    { label: 'E2E', match: '^e2e / gate$', notify: true },
    { label: 'QA run', match: '^qa-run$', notify: true },
    { label: 'AI gate', match: '^review/gate$', showTitle: true, notify: true, alertTitle: '⛔|🔴|Not recommended' },
  ],
  extractors: [
    NEW_REPO_PROFILE.extractors[0],
    { name: 'Preview', source: 'body', regex: '<!-- preview:start -->[\\s\\S]*?:link: (https://\\S+)', kind: 'link', commit: '<!-- preview:start -->[\\s\\S]*?\\| Commit \\| `([0-9a-f]{7,40})`' },
    { name: 'QA', report: 'qa', source: 'comments', contains: '<!-- qa-report -->', notify: true, artifacts: '^qa-screenshots', alert: '🐞' },
    { name: 'Playwright', report: 'playwright', source: 'comments', contains: '<!-- playwright-results -->', notify: true, alert: 'failed' },
    {
      name: 'AI verdict',
      source: 'all',
      contains: '<!-- review-state v1',
      regex: '"verdict":"(block|advisory|clean)"',
      commit: '"sha":"([0-9a-f]{7,40})"',
      kind: 'text',
      notify: true,
      show: { block: '⛔ Not recommended', advisory: '🟡 Advisory', clean: '🟢 Clean' },
      alert: '⛔',
    },
  ],
  actions: [
    { title: 'Request QA', type: 'addLabel', label: 'qa-requested', when: 'ready' },
    { title: 'Request AI review', type: 'addLabel', label: 'ai-review' },
    { title: 'Mark ready', type: 'markReady', when: 'draft' },
    { title: 'no-qa', type: 'toggleLabel', label: 'no-qa' },
    { title: 'Convert to draft', type: 'convertToDraft', when: 'ready' },
    { title: 'Close PR', type: 'close' },
  ],
};

export const cfg = { ...structuredClone(DEFAULT_CONFIG), repos: { [REPO]: PROFILE } };
