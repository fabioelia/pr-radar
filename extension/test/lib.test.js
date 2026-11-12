import assert from 'node:assert/strict';
import test from 'node:test';
import { cfg } from './fixture.js';
import { DEFAULT_CONFIG, NEW_REPO_PROFILE, actionButton, rowSessions, sessionId, sessionLinksIn, tabFor, touchesChecks, mapLimit, mergeConfig, profileFor, scopedQuery, allChecks, checksHidden, diff, flattenContexts, logTail, nameToRegex, regexToName, normalize, rowsForUrl, summarizeErrors, validateConfig } from '../lib.js';

const run = (name, status, conclusion, startedAt, extra = {}) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  title: '',
  detailsUrl: `https://github.com/o/r/actions/runs/1/job/${startedAt.replace(/\D/g, '')}`,
  startedAt,
  ...extra,
});

function pr(overrides = {}) {
  return {
    id: 'PR_1',
    number: 4977,
    title: 'fix(mdx): stop agent-authored MDX from running script',
    url: 'https://github.com/acme/widgets/pull/4977',
    isDraft: false,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    updatedAt: '2026-11-11T18:27:00Z',
    author: { login: 'the-my-bot' },
    repository: { nameWithOwner: 'acme/widgets' },
    body: [
      '## Agent session',
      'https://claude.ai/code/session_01AbCdEf',
      '<!-- preview:start -->',
      '### Preview deployed',
      '',
      ':link: https://pr-4977.preview.example.com',
      '<!-- deploy-token: tok_SECRET -->',
      '<!-- preview:end -->',
    ].join('\n'),
    labels: { nodes: [{ name: 'QA failed', color: 'd73a4a' }, { name: 'jira-ticket', color: 'ccc' }] },
    comments: {
      nodes: [
        { body: 'pushed a fix, see https://claude.ai/code/session_01AbCdEf and https://claude.ai/code/session_02XyZ', url: 'c1' },
        {
          body: '<!-- qa-report -->\r\n> [!CAUTION]\r\n> **🐞 1 defect in 7 checks.** Step 7 fails on QA-1.\r\n> develop · head a09439d\r\n\r\n### 🐞 QA-1 · major — Links lost after reload\r\n',
          url: 'c2',
        },
      ],
    },
    reviews: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  run('CI Success', 'COMPLETED', 'FAILURE', '2026-11-11T18:11:27Z'),
                  run('qa-run', 'COMPLETED', 'SUCCESS', '2026-11-11T18:00:21Z'),
                  // A newer skipped re-trigger of the same job must not mask the real result.
                  run('qa-run', 'COMPLETED', 'SKIPPED', '2026-11-11T18:30:00Z'),
                  run('preview / deploy', 'IN_PROGRESS', null, '2026-11-11T17:46:34Z'),
                  run('review/gate', 'COMPLETED', 'NEUTRAL', '2026-11-11T17:46:15Z', { title: '🔴 ⛔ Not recommended' }),
                ],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

test('normalize maps checks, labels and extracted values', () => {
  const row = normalize(pr(), cfg);
  const byLabel = Object.fromEntries(row.checks.map((c) => [c.label, c]));
  assert.equal(byLabel.CI.state, 'fail');
  assert.equal(byLabel.Preview.state, 'pending');
  assert.equal(byLabel.E2E.state, 'missing');
  assert.equal(byLabel['QA run'].state, 'pass');
  assert.equal(byLabel['AI gate'].title, '🔴 ⛔ Not recommended');
  assert.deepEqual(row.labels.map((l) => l.name), ['QA failed']);
  assert.deepEqual(row.allLabels, ['QA failed', 'jira-ticket']);
  assert.deepEqual(row.extracted.Sessions, ['https://claude.ai/code/session_01AbCdEf', 'https://claude.ai/code/session_02XyZ']);
  assert.deepEqual(row.extracted.Preview, ['https://pr-4977.preview.example.com']);
  assert.deepEqual(row.extracted.QA, ['🐞 1 defect']);
  assert.deepEqual(row.reports.QA.defects, [{ id: 'QA-1', severity: 'major', title: 'Links lost after reload' }]);
  assert.equal(row.reports.QA.url, 'c2');
  assert.ok(!JSON.stringify(row).includes('tok_SECRET'), 'raw body must not be stored');
});

test('attention collects every reason', () => {
  const row = normalize(pr({ mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' }), cfg);
  assert.deepEqual(row.attention, ['QA failed', 'CI failed', 'AI gate: 🔴 ⛔ Not recommended', 'QA: 1 defect', 'Changes requested', 'Merge conflict']);
  const clean = normalize(pr({ labels: { nodes: [] }, commits: { nodes: [] }, comments: { nodes: [] } }), cfg);
  assert.deepEqual(clean.attention, []);
});

test('diff is silent on first load and reports configured changes after', () => {
  const before = normalize(pr({ labels: { nodes: [] }, isDraft: true, comments: { nodes: [] } }), cfg);
  const after = normalize(pr(), cfg);
  assert.deepEqual(diff([], [after], cfg), []);
  assert.deepEqual(diff(undefined, [after], cfg), []);
  const [e] = diff([before], [after], cfg);
  assert.equal(e.url, after.url);
  assert.match(e.message, /Label: QA failed/);
  assert.match(e.message, /QA: 🐞 1 defect/);
  assert.match(e.message, /Marked ready for review/);
  assert.equal(diff([after], [after], cfg).length, 0);
});

test('diff reports check transitions and PRs leaving the list', () => {
  const pending = normalize(pr({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [run('CI Success', 'IN_PROGRESS', null, '2026-11-11T18:00:00Z')] } } } }] } }), cfg);
  const failed = normalize(pr(), cfg);
  const [e] = diff([pending], [failed], cfg);
  assert.match(e.message, /CI failed/);
  assert.match(e.message, /AI gate finished: 🔴 ⛔ Not recommended/);
  const other = normalize(pr({ number: 1, url: 'https://github.com/acme/widgets/pull/1' }), cfg);
  const events = diff([failed, other], [failed], cfg);
  assert.deepEqual(events.map((x) => x.message), ['Left your list (merged or closed?)']);
});

test('rowsForUrl matches PR pages and linked sessions, not prefixes of other numbers', () => {
  const row = normalize(pr(), cfg);
  const short = normalize(pr({ number: 49, url: 'https://github.com/acme/widgets/pull/49', body: '', comments: { nodes: [] } }), cfg);
  const rows = [row, short];
  const keys = (u) => rowsForUrl(rows, u, cfg).map((r) => r.number);
  assert.deepEqual(keys('https://github.com/acme/widgets/pull/4977/files'), [4977]);
  assert.deepEqual(keys('https://github.com/acme/widgets/pull/49'), [49]);
  assert.deepEqual(keys('https://claude.ai/code/session_02XyZ'), [4977]);
  assert.deepEqual(keys('https://claude.ai/code/session_02XyZextra'), []);
  assert.deepEqual(keys(''), []);
});

test('validateConfig rejects bad regexes and unknown actions', () => {
  assert.deepEqual(validateConfig(cfg), []);
  const bad = { ...cfg, repos: { 'o/r': { ...NEW_REPO_PROFILE, checks: [{ label: 'x', match: '(' }], actions: [{ title: 'y', type: 'merge' }] } } };
  const errors = validateConfig(bad);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => e.startsWith('o/r: ')));
  assert.deepEqual(validateConfig({ ...cfg, repos: {} }), ['Add at least one repo: only repos that are set up are tracked.']);
});

test('summarizeErrors collapses per-PR errors into one line per field', () => {
  const msg = 'Resource not accessible by personal access token';
  const errors = [0, 1, 2].flatMap((i) => [
    { message: msg, path: ['search', 'nodes', i, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'] },
    { message: msg, path: ['search', 'nodes', i, 'comments'] },
  ]);
  const lines = summarizeErrors(errors).split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Can't read statusCheckRollup on 3 PRs \(fine-grained tokens can't read check runs; .*Actions jobs instead\): Resource not accessible/);
  assert.match(lines[1], /^Can't read comments on 3 PRs \(needs Issues \+ Pull requests read\)/);
  assert.equal(summarizeErrors([{ message: 'Bad credentials' }]), "Can't read query on 1 PR: Bad credentials");
  assert.match(summarizeErrors([{ message: 'x', path: ['search', 'nodes', 0, 'commits'] }]), /Can't read commits on 1 PR \(needs Contents: read/);
});

test('the QA report records the run linked from the same comment, footer last', () => {
  const body = '<!-- qa-report -->\n> [!TIP]\n> **✅ 5 checks pass.**\nsee https://github.com/o/r/actions/runs/111 for the old run\n_[workflow run](https://github.com/o/r/actions/runs/222) · 2026-11-11_';
  const row = normalize(pr({ comments: { nodes: [{ body, url: 'c' }] } }), cfg);
  assert.deepEqual(row.extracted.QA, ['✅ Clean']);
  assert.equal(row.artifactRuns.QA, '222');
  assert.equal(row.artifactRuns.Sessions, undefined, 'only extractors with `artifacts` record a run');
});

test('actionButton maps label actions to one setLabels write and hides no-ops', () => {
  const on = (l) => l === 'no-qa';
  const off = () => false;
  const toggle = { title: 'no-qa', type: 'toggleLabel', label: 'no-qa' };
  assert.deepEqual(actionButton(toggle, off), { title: '+ no-qa', action: { type: 'setLabels', add: ['no-qa'] } });
  assert.deepEqual(actionButton(toggle, on), { title: '− no-qa', action: { type: 'setLabels', remove: ['no-qa'] } });
  assert.equal(actionButton({ title: 'x', type: 'addLabel', label: 'no-qa' }, on), null);
  assert.equal(actionButton({ title: 'x', type: 'removeLabel', label: 'no-qa' }, off), null);
  const close = { title: 'Close', type: 'close' };
  assert.deepEqual(actionButton(close, off), { title: 'Close', action: close });
});

test('null nodes from a partial-permission response are skipped', () => {
  const row = normalize(
    pr({
      labels: { nodes: [null, { name: 'no-qa', color: 'ccc' }] },
      comments: { nodes: [null] },
      reviews: { nodes: [null] },
      commits: { nodes: [null, { commit: { statusCheckRollup: { contexts: { nodes: [null, run('CI Success', 'COMPLETED', 'SUCCESS', '2026-11-11T18:00:00Z')] } } } }] },
    }),
    cfg,
  );
  assert.deepEqual(row.allLabels, ['no-qa']);
  assert.equal(row.checks[0].state, 'pass');
});

test('allChecks lists every check once, failures first, with job ids and annotations', () => {
  const failing = run('ci / Backend Test', 'COMPLETED', 'FAILURE', '2026-11-11T18:05:00Z', {
    summary: 'pytest failed',
    checkSuite: { workflowRun: { workflow: { name: 'PR' } } },
    annotations: { nodes: [null, { path: 'apps/x.py', message: 'AssertionError', annotationLevel: 'FAILURE', location: { start: { line: 12 } } }] },
  });
  const checks = allChecks(flattenContexts(pr({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [...pr().commits.nodes[0].commit.statusCheckRollup.contexts.nodes, failing] } } } }] } })));
  assert.deepEqual(checks.map((c) => `${c.state}:${c.name}`), [
    'fail:ci / Backend Test',
    'fail:CI Success',
    'pending:preview / deploy',
    'neutral:review/gate',
    'pass:qa-run',
  ]);
  const backend = checks[0];
  assert.equal(backend.jobId, '20261111180500');
  assert.equal(backend.workflow, 'PR');
  assert.deepEqual(backend.annotations, [{ level: 'FAILURE', path: 'apps/x.py', line: 12, message: 'AssertionError' }]);
});

test('logTail strips timestamps, pulls error lines and ends at the first error', () => {
  const ts = (l) => `2026-11-11T18:00:00.1Z ${l}`;
  const body = Array.from({ length: 70 }, (_, i) => ts(`step ${i}`));
  const text = [ts('setup'), ...body, ts('FAILED tests/test_x.py::test_a - AssertionError: 403 != 200'), ts('##[error]Process completed with exit code 1.'), ts('Post job cleanup.'), ts('git config --unset'), '', ''].join('\r\n');
  const { errors, tail } = logTail(text);
  assert.deepEqual(errors, ['FAILED tests/test_x.py::test_a - AssertionError: 403 != 200', 'Process completed with exit code 1.']);
  const lines = tail.split('\n');
  assert.equal(lines.length, 60);
  assert.equal(lines.at(-1), '##[error]Process completed with exit code 1.');
  assert.ok(!tail.includes('Post job cleanup'), 'cleanup after the error is left out');
  assert.equal(logTail(ts('only line')).tail, 'only line');
});

test('check names round-trip through the form and patterns stay patterns', () => {
  for (const name of ['CI Success', 'preview / deploy', 'codeql / Analyze (python)', 'review/gate', 'a.b*c']) {
    const re = nameToRegex(name);
    assert.ok(new RegExp(re).test(name), re);
    assert.ok(!new RegExp(re).test(`${name}x`), re);
    assert.equal(regexToName(re), name);
  }
  assert.equal(nameToRegex('/^ci .*Test$/'), '^ci .*Test$');
  assert.equal(nameToRegex('*'), '.');
  assert.equal(regexToName(NEW_REPO_PROFILE.checks[0].match), '*');
  assert.equal(regexToName('^ci .*Test$'), '/^ci .*Test$/');
  assert.deepEqual(profileFor(cfg, 'acme/widgets').checks.map((c) => regexToName(c.match)), ['CI Success', 'preview / deploy', 'e2e / gate', 'qa-run', 'review/gate']);
});

test('checksHidden spots nulled check runs; the AI verdict reads the last review cycle and alerts on block', () => {
  assert.equal(checksHidden(pr()), false);
  assert.equal(checksHidden(pr({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [null] } } } }] } })), true);
  const review = '## AI Review\n<!-- ai-review -->\n<!-- review-state v1 {"v":1,"cycle":2,"findings":[],"cycles":[{"n":1,"verdict":"clean"},{"n":2,"verdict":"block"}]} -->';
  const row = normalize(pr({ labels: { nodes: [] }, commits: { nodes: [] }, comments: { nodes: [] }, reviews: { nodes: [{ body: review, url: 'r' }] } }), cfg);
  assert.deepEqual(row.extracted['AI verdict'], ['⛔ Not recommended']);
  assert.deepEqual(row.attention, ['AI verdict: ⛔ Not recommended']);
});

test('normalize takes substitute contexts (Actions jobs) when given', () => {
  const contexts = [{ name: 'CI Success', state: 'fail', title: 'Failed at: Run tests', url: 'https://github.com/o/r/actions/runs/1/job/2', at: '2026-11-11T00:00:00Z' }];
  const row = normalize(pr(), cfg, contexts);
  assert.equal(row.checks[0].state, 'fail');
  assert.equal(row.checks[1].state, 'missing');
});

test('an old top-level profile is dropped; a config keeps its repos; the defaults track no repo', () => {
  const legacy = { pollMinutes: 5, labels: [{ name: 'x', kind: 'alert' }], checks: [], extractors: [], actions: [] };
  const m = mergeConfig(legacy);
  assert.equal(m.pollMinutes, 5);
  assert.deepEqual(m.repos, {});
  assert.equal(m.labels, undefined);
  assert.deepEqual(Object.keys(mergeConfig({ repos: { 'a/b': NEW_REPO_PROFILE } }).repos), ['a/b']);
  assert.deepEqual(mergeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(DEFAULT_CONFIG.repos, {});
  assert.deepEqual(DEFAULT_CONFIG.badgePages, []);
});

test('badge pages must be https match patterns', () => {
  const errors = (badgePages) => validateConfig({ ...cfg, badgePages }).filter((e) => e.startsWith('badge page'));
  assert.deepEqual(errors([{ match: 'https://*.preview.example.com/*' }, { match: 'https://app.example.com/*' }]), []);
  assert.equal(errors([{ match: 'http://*.example.com/*' }]).length, 1);
  assert.equal(errors([{ match: 'https://*.example.com/path' }]).length, 1);
  assert.equal(errors([{ match: '' }]).length, 1);
});

test('searches are limited to the set-up repos', () => {
  const two = { ...cfg, repos: { 'a/b': NEW_REPO_PROFILE, 'c/d': NEW_REPO_PROFILE } };
  assert.equal(scopedQuery('is:pr is:open author:@me', two), 'is:pr is:open author:@me repo:a/b repo:c/d');
});

test('a new repo gets one rollup chip: worst state of every check, one run per name', () => {
  const other = { ...cfg, repos: { 'a/b': NEW_REPO_PROFILE } };
  const contexts = [
    { name: 'lint', state: 'pass', at: '1' },
    { name: 'test', state: 'fail', at: '1', url: 'u-old' },
    { name: 'test', state: 'pass', at: '2', url: 'u-new' },
    { name: 'build', state: 'pending', at: '1', url: 'u-build' },
  ];
  const row = normalize(pr({ repository: { nameWithOwner: 'a/b' } }), other, contexts);
  assert.deepEqual(row.checks, [{ label: 'All checks', state: 'pending', title: '1 of 3 pending', url: 'u-build' }]);
  const failing = normalize(pr({ repository: { nameWithOwner: 'a/b' } }), other, [...contexts, { name: 'e2e', state: 'fail', at: '1', url: 'u-e2e' }]);
  assert.equal(failing.checks[0].state, 'fail');
  assert.equal(failing.checks[0].url, 'u-e2e');
  assert.deepEqual(failing.attention, ['All checks failed']);
});

test('mapLimit keeps order and never runs more than `limit` at once', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
});

test('tabFor prefers the exact page, then a page under it, never a longer PR number', () => {
  const pr = 'https://github.com/o/r/pull/49';
  const tabs = [
    { id: 1, url: 'https://github.com/o/r/pull/4977' },
    { id: 2, url: 'https://github.com/o/r/pull/49/files?w=1' },
    { id: 3, url: 'https://github.com/o/r/pull/49#issuecomment-1' },
  ];
  assert.equal(tabFor(tabs, pr).id, 3);
  assert.equal(tabFor(tabs.slice(0, 2), pr).id, 2);
  assert.equal(tabFor(tabs.slice(0, 1), pr), null);
  assert.equal(tabFor([], pr), null);
});

test('summarizeErrors counts PRs, not errors, and explains hidden check runs', () => {
  const msg = 'Resource not accessible by personal access token';
  const thirty = Array.from({ length: 30 }, (_, k) => ({ message: msg, path: ['search', 'nodes', 0, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup', 'contexts', 'nodes', k] }));
  assert.match(summarizeErrors(thirty), /^Can't read contexts on 1 PR \(fine-grained tokens can't read check runs; .*Actions jobs instead\): Resource not accessible/);
  assert.ok(thirty.every(touchesChecks));
  assert.equal(touchesChecks({ message: msg, path: ['search', 'nodes', 0, 'comments'] }), false);
});

test('a session page matches its PR by session ID, whatever else is in the URL', () => {
  const row = normalize(pr(), cfg);
  const keys = (u) => rowsForUrl([row], u, cfg).map((r) => r.number);
  assert.deepEqual(keys('https://claude.ai/code/session_02XyZ'), [4977]);
  assert.deepEqual(keys('https://claude.ai/code/session_02XyZ/'), [4977]);
  assert.deepEqual(keys('https://claude.ai/code/session_02XyZ?tab=diff#x'), [4977]);
  assert.deepEqual(keys('https://claude.ai/code/sessions/session_02XyZ'), [4977]);
  assert.deepEqual(keys('https://claude.ai/code/session_02XyZextra'), []);
  assert.deepEqual(keys('https://claude.ai/code/session_99Other'), []);
  assert.equal(sessionId('https://claude.ai/new'), '');
});

test('session links come out of PR text and polled PRs, once each', () => {
  assert.deepEqual(sessionLinksIn(['see https://claude.ai/code/session_01Ab and https://claude.ai/code/session_02Cd.', null, 'again https://claude.ai/code/session_01Ab']), [
    'https://claude.ai/code/session_01Ab',
    'https://claude.ai/code/session_02Cd',
  ]);
  assert.deepEqual(sessionLinksIn(['no links here']), []);
  assert.deepEqual(rowSessions(normalize(pr(), cfg)), ['https://claude.ai/code/session_01AbCdEf', 'https://claude.ai/code/session_02XyZ']);
});

test('tabFor finds a session tab by its ID, whatever else is in its URL', () => {
  const tabs = [{ id: 1, url: 'https://claude.ai/code/session_09Zz' }, { id: 2, url: 'https://claude.ai/code/session_01Ab?tab=diff' }];
  assert.equal(tabFor(tabs, 'https://claude.ai/code/session_01Ab').id, 2);
  assert.equal(tabFor(tabs, 'https://claude.ai/code/session_03Ef'), null);
});
