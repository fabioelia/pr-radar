import assert from 'node:assert/strict';
import test from 'node:test';
import { cfg } from './fixture.js';
import { diff, normalize, quietKeys, validateConfig, watchReason, watchedKeys } from '../lib.js';

const check = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, conclusion, title: '', detailsUrl: '', startedAt: '2026-11-11T00:00:00Z' });
function pr({ checks = [], labels = [], comments = [] } = {}) {
  return {
    id: 'PR_1', number: 1, title: 'A PR', url: 'https://github.com/acme/widgets/pull/1', isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: null, updatedAt: '2026-11-11T00:00:00Z', headRefOid: 'abc',
    author: { login: 'me' }, repository: { nameWithOwner: 'acme/widgets' }, body: '',
    labels: { nodes: labels.map((name) => ({ name, color: 'ccc' })) }, comments: { nodes: comments.map((body, i) => ({ body, url: `c${i}` })) }, reviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
  };
}

test('a PR is watched while a check that notifies is running, or by its bell', () => {
  const running = normalize(pr({ checks: [check('qa-run', 'IN_PROGRESS', null)] }), cfg);
  const done = normalize(pr({ checks: [check('qa-run', 'COMPLETED', 'SUCCESS')] }), cfg);
  assert.equal(watchReason(running, cfg), 'auto');
  assert.equal(watchReason(done, cfg), null);
  assert.equal(watchReason(done, cfg, new Set([done.key])), 'manual');
  assert.equal(watchReason(running, { ...cfg, autoWatch: false }), null);
  // A running check nobody asked to be told about doesn't count.
  const quiet = { ...cfg, repos: { 'acme/widgets': { ...cfg.repos['acme/widgets'], checks: [{ label: 'QA run', match: '^qa-run$' }] } } };
  assert.equal(watchReason(normalize(pr({ checks: [check('qa-run', 'IN_PROGRESS', null)] }), quiet), quiet), null);
  // A Playwright run still in progress counts, as its report notifies.
  const pw = normalize(pr({ comments: ['### Playwright Test Results\n\n⏳ **Running…** 10/50 tests · 1/5 suites\n<!-- playwright-results -->'] }), cfg);
  assert.equal(watchReason(pw, cfg), 'auto');
});

test('the QA run landing notifies; a bell makes every change notify', () => {
  const before = normalize(pr({ checks: [check('qa-run', 'IN_PROGRESS', null)] }), cfg);
  const after = normalize(pr({ checks: [check('qa-run', 'COMPLETED', 'FAILURE')], labels: ['jira-ticket'] }), cfg);
  assert.deepEqual(diff([before], [after], cfg).map((e) => e.message), ['QA run failed']);
  assert.deepEqual(diff([before], [after], cfg, new Set([after.key])).map((e) => e.message), ['Label: jira-ticket\nQA run failed']);
});

test('a rung group watches its PRs, new ones included, except those unwatched one by one', () => {
  const snap = (keys) => ({ sections: [{ title: 'My PRs', keys }, { title: 'Review requested', keys: ['o/r#9'] }] });
  const lists = { watched: ['o/r#9'], watchedGroups: ['My PRs'], unwatched: ['o/r#2'] };
  assert.deepEqual([...watchedKeys(snap(['o/r#1', 'o/r#2']), lists)].sort(), ['o/r#1', 'o/r#9']);
  // A PR that joins the group later is watched without anyone ringing anything.
  assert.deepEqual([...watchedKeys(snap(['o/r#1', 'o/r#2', 'o/r#3']), lists)].sort(), ['o/r#1', 'o/r#3', 'o/r#9']);
  assert.deepEqual([...watchedKeys(snap(['o/r#1']), {})], []);
});

test('muted PRs and muted searches stay quiet; a bell beats a muted search, not a muted PR', () => {
  const config = { ...cfg, queries: [{ title: 'Mine', q: 'a' }, { title: 'Reviews', q: 'b', mute: true }] };
  const sections = [{ title: 'Mine', keys: ['acme/widgets#1', 'acme/widgets#2'] }, { title: 'Reviews', keys: ['acme/widgets#3', 'acme/widgets#4'] }];
  const quiet = quietKeys(sections, config, ['acme/widgets#1'], new Set(['acme/widgets#4']));
  assert.deepEqual([...quiet].sort(), ['acme/widgets#1', 'acme/widgets#3']);
});

test('the event switches turn off new, left and ready notifications', () => {
  const row = (n, extra = {}) => ({ key: `acme/widgets#${n}`, repo: 'acme/widgets', number: n, title: `PR ${n}`, url: `u${n}`, isDraft: false, allLabels: [], checks: [], extracted: {}, ...extra });
  const prev = [row(1, { isDraft: true }), row(2)];
  const next = [row(1), row(3)];
  const messages = (notifyOn, quiet) => diff(prev, next, { ...cfg, notifyOn }, new Set(), {}, quiet).map((e) => `${e.key}: ${e.message}`);
  assert.deepEqual(messages({ newPR: true, left: true, ready: true }), ['acme/widgets#1: Marked ready for review', 'acme/widgets#3: New in your list', 'acme/widgets#2: Left your list (merged or closed?)']);
  assert.deepEqual(messages({ newPR: false, left: false, ready: false }), []);
  assert.deepEqual(messages({}, new Set(['acme/widgets#1', 'acme/widgets#2'])), ['acme/widgets#3: New in your list']);
});

test('a report notifies on its milestones, not on every progress update', () => {
  const config = { ...cfg, repos: { 'acme/widgets': { ...cfg.repos['acme/widgets'], labels: [], checks: [], extractors: [{ name: 'Playwright', report: 'playwright', source: 'comments', contains: 'x', notify: true, alert: 'failed' }] } } };
  const row = (summary, report) => ({ key: 'acme/widgets#1', repo: 'acme/widgets', number: 1, title: 't', url: 'u', isDraft: false, allLabels: [], checks: [], extracted: { Playwright: [summary] }, reports: { Playwright: { kind: 'playwright', run: '9', ...report } } });
  const step = (a, b, c = config) => diff([a], [b], c).map((e) => e.message);
  const r1 = row('⏳ Running 100/1046', { state: 'running', failed: 0 });
  const r2 = row('⏳ Running 400/1046', { state: 'running', failed: 0 });
  const r3 = row('⏳ Running 500/1046 · 1 failed so far', { state: 'running', failed: 1 });
  const r4 = row('⏳ Running 900/1046 · 6 failed so far', { state: 'running', failed: 6 });
  const r5 = row('❌ 1038/1046 passed · 8 failed', { state: 'failed', failed: 8 });
  const ok = row('✅ 1046/1046 passed', { state: 'passed', failed: 0 });
  assert.deepEqual(step(r1, r2), [], 'progress alone is quiet');
  assert.deepEqual(step(r2, r3), ['Playwright: ⏳ Running 500/1046 · 1 failed so far'], 'the first failure notifies');
  assert.deepEqual(step(r3, r4), [], 'more failures while running are quiet');
  assert.deepEqual(step(r4, r5), ['Playwright: ❌ 1038/1046 passed · 8 failed']);
  assert.deepEqual(step(r2, ok), ['Playwright: ✅ 1046/1046 passed']);
  const failOnly = { ...config, repos: { 'acme/widgets': { ...config.repos['acme/widgets'], extractors: [{ ...config.repos['acme/widgets'].extractors[0], notify: 'fail' }] } } };
  assert.deepEqual(step(r2, ok, failOnly), [], 'Only failures skips a pass');
  assert.deepEqual(step(r4, r5, failOnly), ['Playwright: ❌ 1038/1046 passed · 8 failed']);
});

test('Only failures on a check skips passes and keeps failures and alert titles', () => {
  const checks = [{ label: 'CI', match: '^CI$', notify: 'fail' }, { label: 'Gate', match: '^gate$', notify: 'fail', showTitle: true, alertTitle: 'Not recommended' }];
  const config = { ...cfg, repos: { 'acme/widgets': { ...cfg.repos['acme/widgets'], labels: [], extractors: [], checks } } };
  const row = (ci, gate) => ({ key: 'acme/widgets#1', repo: 'acme/widgets', number: 1, title: 't', url: 'u', isDraft: false, allLabels: [], extracted: {}, checks: [{ label: 'CI', state: ci, title: '' }, { label: 'Gate', state: 'neutral', title: gate }] });
  assert.deepEqual(diff([row('pending', 'Clean')], [row('pass', 'Clean')], config), []);
  assert.deepEqual(diff([row('pending', 'Clean')], [row('fail', 'Clean')], config).map((e) => e.message), ['CI failed']);
  assert.deepEqual(diff([row('pass', 'Clean')], [row('pass', '⛔ Not recommended')], config).map((e) => e.message), ['Gate: ⛔ Not recommended']);
});

test('notify must be true, false or "fail", and "fail" on an extractor needs an alert pattern', () => {
  const withEx = (ex) => validateConfig({ ...cfg, repos: { 'acme/widgets': { ...cfg.repos['acme/widgets'], extractors: [{ name: 'X', source: 'body', regex: 'x', ...ex }] } } }).filter((e) => e.includes('"X"'));
  assert.deepEqual(withEx({ notify: 'fail', alert: 'bad' }), []);
  assert.equal(withEx({ notify: 'fail' }).length, 1);
  assert.equal(withEx({ notify: 'sometimes' }).length, 1);
});
