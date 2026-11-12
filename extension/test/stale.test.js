import assert from 'node:assert/strict';
import test from 'node:test';
import { cfg } from './fixture.js';
import { applyRunCommits, normalize, parsePlaywrightReport, parseQaReport } from '../lib.js';

const HEAD = 'bbbbbbb111111111111111111111111111111111';
const OLD = 'aaaaaaa222222222222222222222222222222222';
const QA = `<!-- qa-report -->\n> [!CAUTION]\n> **🐞 1 defect in 7 checks.**\n> develop · 2026-11-11 · regular user \`qa\` · head \`${OLD.slice(0, 7)}\`\n\n### 🐞 QA-1 · major — Broken\n\n_[workflow run](https://github.com/o/r/actions/runs/555) · 2026-11-11_`;
const PW = '### Playwright Test Results\n\n✅ Tests **passed**\n\n**Stats:** 10 passed, 0 failed, 0 skipped · ran in 1m\n<!-- run-id: 777 -->\n<!-- playwright-results -->';
const review = (sha) => `<!-- ai-review -->\n<!-- review-state v1 {"v":1,"cycle":2,"findings":[],"cycles":[{"n":1,"sha":"${OLD.slice(0, 7)}","verdict":"block"},{"n":2,"sha":"${sha}","verdict":"clean"}]} -->`;
const preview = (sha) => `<!-- preview:start -->\n### Preview deployed\n\n:link: https://pr-1.preview.example\n\n| | |\n|---|---|\n| Image tag | \`x\` |\n| Commit | \`${sha}\` |\n<!-- preview:end -->`;

function pr({ head = HEAD, comments = [], body = '' } = {}) {
  return {
    id: 'PR_1', number: 1, title: 't', url: 'https://github.com/acme/widgets/pull/1', isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: null, updatedAt: '2026-11-11T00:00:00Z',
    headRefOid: head, author: { login: 'me' }, repository: { nameWithOwner: 'acme/widgets' }, body,
    labels: { nodes: [] }, comments: { nodes: comments.map((b, i) => ({ body: b, url: `c${i}` })) }, reviews: { nodes: [] }, commits: { nodes: [] },
  };
}

test('reports know their commit: QA from its verdict line, Playwright by its run', () => {
  assert.deepEqual([parseQaReport(QA).sha, parseQaReport(QA).run], [OLD.slice(0, 7), '555']);
  assert.deepEqual([parsePlaywrightReport(PW).sha, parsePlaywrightReport(PW).run], ['', '777']);
});

test('values made for an older commit are stale, and say so in "needs you"', () => {
  const row = normalize(pr({ comments: [QA, PW, review(HEAD.slice(0, 7))], body: preview(OLD.slice(0, 7)) }), cfg);
  // QA names an older head; the preview was deployed for an older commit;
  // the AI review's last cycle is on the latest; Playwright isn't known yet.
  assert.deepEqual(row.staleReports, { QA: OLD.slice(0, 7), Preview: OLD.slice(0, 7) });
  assert.ok(row.attention.includes('QA: 1 defect (stale)'));
  assert.equal(row.madeFor.Playwright.run, '777');
  // Once the run's commit is known, Playwright is judged too.
  applyRunCommits(row, { 777: OLD }, cfg);
  assert.deepEqual(Object.keys(row.staleReports).sort(), ['Playwright', 'Preview', 'QA']);
  applyRunCommits(row, {}, cfg);
  assert.ok('Playwright' in row.staleReports, 'a commit once known stays known');
});

test('nothing is stale when everything was made for the latest push, or commits are unknown', () => {
  const fresh = normalize(pr({ comments: [QA.replace(OLD.slice(0, 7), HEAD.slice(0, 7)), review(HEAD)], body: preview(HEAD.slice(0, 7)) }), cfg);
  assert.deepEqual(fresh.staleReports, {});
  assert.ok(fresh.attention.includes('QA: 1 defect'));
  const unknownHead = normalize(pr({ head: '', comments: [QA] }), cfg);
  assert.deepEqual(unknownHead.staleReports, {});
});
