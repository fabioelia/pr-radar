// Pure logic shared by the service worker, the side panel and the tests:
// config defaults, the GitHub query, PR normalization, attention rules and
// change detection. No chrome.* calls here, so `node --test` can load it.

// Claude Code session links, from the PR body's "## Agent session" section
// or any comment.
const SESSIONS = { name: 'Sessions', source: 'all', regex: 'https://claude\\.ai/code/session_[A-Za-z0-9]+', all: true, kind: 'link' };

// A profile is the per-repo part of the config: labels, checks, extractors
// and actions. Only repos with a profile in `repos` are tracked: searches are
// limited to them, and PRs from any other repo are ignored.
export const PROFILE_KEYS = ['labels', 'checks', 'extractors', 'actions'];

// What a newly added repo starts with.
//   labels:  {name, kind, notify}. kind: alert | ok | pending | info; an
//            `alert` label puts the PR in "needs you"; notify on add.
//   checks:  {label, match, rollup, notify, showTitle, alertTitle}. match: a
//            regex on the check name; rollup: one chip summing every match
//            (the worst state wins); showTitle: show the check's output
//            title; alertTitle: a regex on it that means "needs you".
//   extractors: {name, source, regex, contains, all, kind, notify, show,
//            alert, artifacts, commit, report}. Pull values out of the PR
//            body (source body), its comments and reviews (comments), or
//            both (all); contains: only texts holding this marker; regex:
//            group 1 if present, else the whole match; report: qa |
//            playwright parses the newest matching text into a report block
//            instead; commit: a regex whose group 1 is the commit the value
//            was made for, so an older one shows as stale. Raw PR text is
//            never stored, only what these extract, so keep them off secrets.
//   actions: {title, type, label, when}. type: addLabel | removeLabel |
//            toggleLabel | markReady | convertToDraft | close; when: draft |
//            ready (omit for always).
export const NEW_REPO_PROFILE = {
  labels: [],
  checks: [{ label: 'All checks', match: '.', rollup: true, showTitle: true, notify: true }],
  extractors: [SESSIONS],
  actions: [
    { title: 'Mark ready', type: 'markReady', when: 'draft' },
    { title: 'Convert to draft', type: 'convertToDraft', when: 'ready' },
    { title: 'Close PR', type: 'close' },
  ],
};

export const DEFAULT_CONFIG = {
  // Minutes between polls while a check is running, and once everything has
  // settled. No polling at all while the computer is locked or idle.
  pollMinutes: 2,
  quietPollMinutes: 10,
  // Watched PRs are checked on their own every watchSeconds: a PR with a
  // running check that notifies (autoWatch), until it lands, and any PR you
  // watch with its bell, which notifies on every change.
  watchSeconds: 30,
  autoWatch: true,
  // Where check results come from. checks: GitHub's Checks API (classic
  // token). actions: the Actions jobs API, which fine-grained tokens can
  // read but which only knows Actions jobs. auto: Checks API, falling back
  // to Actions for any PR whose check runs come back hidden.
  checksSource: 'auto',
  // GitHub search syntax. Each query is one section in the panel; a PR that
  // matches several shows once, under the first. Each is limited to `repos`.
  queries: [
    { title: 'My PRs', q: 'is:pr is:open author:@me archived:false' },
    { title: 'Review requested', q: 'is:pr is:open review-requested:@me archived:false' },
  ],
  showOtherLabels: false,
  attention: { failedChecks: true, changesRequested: true, conflicts: true },
  // Sites besides claude.ai and github.com that show the PR badge, such as
  // a team's preview deployments: Chrome match patterns
  // (https://*.preview.example.com/*). A page shows the badge of the tracked
  // PR whose extracted links point at it; the badge never requests the page.
  badgePages: [],
  // owner/name → profile. Only these repos are tracked.
  repos: {},
};

// The fields of a PR the panel reads, shared by the search (QUERY) and the
// watch tick (WATCH_QUERY), so a watched PR comes back exactly as polled.
const PR_FIELDS = `
fragment PrFields on PullRequest {
  id number title url isDraft state mergeable reviewDecision updatedAt body headRefOid
  author { login }
  repository { nameWithOwner }
  labels(first: 30) { nodes { name color } }
  comments(last: 30) { nodes { body url } }
  reviews(last: 10) { nodes { body url } }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion title detailsUrl startedAt }
              ... on StatusContext { context state description targetUrl createdAt }
            }
          }
        }
      }
    }
  }
}`;

export const QUERY = `
query Radar($q: String!, $n: Int!) {
  rateLimit { remaining resetAt }
  search(query: $q, type: ISSUE, first: $n) {
    nodes { ...PrFields }
  }
}
${PR_FIELDS}`;

// The watched PRs, by node ID, in one request.
export const WATCH_QUERY = `
query Watch($ids: [ID!]!) {
  rateLimit { remaining resetAt }
  nodes(ids: $ids) { ...PrFields }
}
${PR_FIELDS}`;

export const CONCLUSION = {
  SUCCESS: 'pass',
  FAILURE: 'fail',
  TIMED_OUT: 'fail',
  STARTUP_FAILURE: 'fail',
  ACTION_REQUIRED: 'fail',
  CANCELLED: 'cancelled',
  NEUTRAL: 'neutral',
  STALE: 'neutral',
  SKIPPED: 'skipped',
};
const STATUS_STATE = { SUCCESS: 'pass', FAILURE: 'fail', ERROR: 'fail', PENDING: 'pending', EXPECTED: 'pending' };

// A config saved before per-repo profiles had its profile at the top level;
// with no repo to put it under, it is dropped.
export function mergeConfig(user) {
  if (!user) return structuredClone(DEFAULT_CONFIG);
  const { labels, checks, extractors, actions, ...rest } = user;
  return { ...structuredClone(DEFAULT_CONFIG), ...rest, repos: user.repos || {} };
}

// The settings that apply to a PR in `repo`. A repo that isn't set up gets
// NEW_REPO_PROFILE; the service worker doesn't show those PRs at all.
export function profileFor(config, repo) {
  return { ...config, ...(config.repos?.[repo] || NEW_REPO_PROFILE) };
}

// GitHub ORs repeated repo: qualifiers, so this limits a search to the repos
// that are set up.
export function scopedQuery(q, config) {
  return `${q} ${Object.keys(config.repos || {}).map((r) => `repo:${r}`).join(' ')}`;
}

// A connection's nodes without the nulls GitHub puts in place of entries the
// token may not read (a partial-permission response).
export const nodes = (conn) => (conn?.nodes || []).filter(Boolean);

export function flattenContexts(pr) {
  const head = nodes(pr.commits)[0];
  return nodes(head?.commit?.statusCheckRollup?.contexts).map((c) =>
    c.__typename === 'CheckRun'
      ? {
          name: c.name,
          state: c.status !== 'COMPLETED' ? 'pending' : CONCLUSION[c.conclusion] || 'neutral',
          title: c.title || '',
          url: c.detailsUrl,
          at: c.startedAt || '',
          // Only CHECKS_QUERY (the details pane) asks for these.
          summary: c.summary || '',
          workflow: c.checkSuite?.workflowRun?.workflow?.name || '',
          annotations: nodes(c.annotations).map((a) => ({
            level: a.annotationLevel,
            path: a.path,
            line: a.location?.start?.line,
            message: a.message,
          })),
        }
      : {
          name: c.context,
          state: STATUS_STATE[c.state] || 'neutral',
          title: c.description || '',
          url: c.targetUrl,
          at: c.createdAt || '',
        },
  );
}

const STATE_ORDER = ['fail', 'cancelled', 'pending', 'neutral', 'pass', 'skipped'];

// One summary for many checks: the worst state among them (one run per
// name), linking to the first check in that state.
function rollup(runs) {
  const latest = [...Map.groupBy(runs, (r) => r.name).values()].map(pickCheck);
  const worst = latest.reduce((a, b) => (STATE_ORDER.indexOf(b.state) < STATE_ORDER.indexOf(a.state) ? b : a));
  const n = latest.filter((r) => r.state === worst.state).length;
  return { ...worst, title: `${n} of ${latest.length} ${worst.state}` };
}

// Every check on the head commit, one per name, failures first.
// True when GitHub hid check runs from this token: it returns null in their
// place (fine-grained tokens can't call the Checks API).
export function checksHidden(pr) {
  const head = nodes(pr.commits)[0];
  return (head?.commit?.statusCheckRollup?.contexts?.nodes || []).some((n) => n === null);
}

export function allChecks(contexts) {
  const byName = Map.groupBy(contexts, (c) => c.name);
  return [...byName.values()]
    .map(pickCheck)
    .map((c) => ({ ...c, jobId: c.url?.match(/\/job\/(\d+)/)?.[1] || '' }))
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.name.localeCompare(b.name));
}

// The lines that name the failure, and the `n` lines of an Actions job log
// that lead up to its first ##[error] (or the last `n` when there is none),
// with the runner's timestamp prefix removed. The end of a failed job's log
// is its post-job cleanup, not the failure. ponytail: "names the failure" is
// a heuristic (##[error], pytest FAILED/ERROR, "SomeError:"), capped at 20.
export function logTail(text, n = 60) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const firstError = lines.findIndex((l) => l.startsWith('##[error]'));
  const end = firstError === -1 ? lines.length : firstError + 1;
  return {
    errors: lines
      .filter((l) => /^##\[error\]|^(FAILED|ERROR) |\b[A-Z]\w*Error:/.test(l))
      .map((l) => l.replace(/^##\[error\]/, ''))
      .slice(0, 20),
    tail: lines.slice(Math.max(0, end - n), end).join('\n'),
  };
}

// A workflow re-triggered by a label event often re-reports the same job name
// as skipped, so the newest non-skipped run wins; skipped only if all are.
function pickCheck(runs) {
  const byNewest = [...runs].sort((a, b) => (a.at < b.at ? 1 : -1));
  return byNewest.find((r) => r.state !== 'skipped') || byNewest[0];
}

function texts(pr, source, contains) {
  const comments = [...nodes(pr.comments), ...nodes(pr.reviews)].map((c) => ({ body: c.body || '', url: c.url }));
  const body = { body: pr.body || '', url: pr.url };
  const list = source === 'body' ? [body] : source === 'comments' ? comments : [body, ...comments];
  return contains ? list.filter((t) => t.body.includes(contains)) : list;
}

// Markdown emphasis and code marks dropped, for showing a line as plain text.
const plain = (t) => t.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

// Splits markdown into its `#`-heading sections: [{ heading, body }].
function sections(text) {
  const out = [{ heading: '', body: '' }];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^#{2,4} /.test(line)) out.push({ heading: line.replace(/^#+ /, ''), body: '' });
    else out[out.length - 1].body += `${line}\n`;
  }
  return out;
}

// A QA report comment: a verdict alert (`> [!CAUTION]` / WARNING / TIP, then
// `> **verdict**`, naming the commit tested as head `sha`), a checks table
// whose ❌ ⛔ ⚠️ rows are kept, a `### QA-n · severity — title` heading per
// defect, and `- **UX-n · title**` bullets under a "UX notes" heading.
export function parseQaReport(text) {
  const t = text.replace(/\r/g, '');
  const tone = t.match(/^> \[!(CAUTION|WARNING|TIP)\]/m)?.[1] || '';
  const verdict = plain(t.match(/^> \[!(?:CAUTION|WARNING|TIP)\]\s*\n> \*\*(.+?)\*\*/m)?.[1] || '');
  const defects = [...t.matchAll(/^### (?:🐞\s*)?(QA-\d+)\s*·\s*([^—\n]+?)\s*—\s*(.+)$/gm)].map((m) => ({
    id: m[1],
    severity: m[2].trim().toLowerCase(),
    title: plain(m[3]),
  }));
  const KIND = { '❌': 'fail', '⛔': 'blocked', '⚠️': 'flaky' };
  const checks = [...t.matchAll(/^\|\s*(❌|⛔|⚠️)\s*\|\s*([^|\n]+?)\s*\|/gm)].map((m) => ({ kind: KIND[m[1]], title: plain(m[2]) }));
  const uxSection = sections(t).find((s) => /UX notes/i.test(s.heading));
  const ux = [...(uxSection?.body || '').matchAll(/^- \*\*(UX-\d+)\s*·\s*(.+?)\*\*/gm)].map((m) => ({ id: m[1], title: plain(m[2]) }));
  // The verdict's second line names the commit tested ("· head `2840d01`").
  const sha = t.match(/^>.*\bhead `([0-9a-f]{7,40})`/m)?.[1] || '';
  return { kind: 'qa', tone, verdict, defects, checks, ux, sha, run: lastRun(t) };
}

// A Playwright results comment: "⏳ **Running…** n/N tests" and "**So far:**"
// while running, "**Stats:**" once done, then "#### Failed Tests:" /
// "#### Failing so far:" and "#### :warning: Flaky" lists of
// "- **title** (`file`)" lines.
export function parsePlaywrightReport(text) {
  const t = text.replace(/\r/g, '');
  const num = (v) => (v === undefined ? 0 : Number(v));
  const running = t.match(/\*\*Running…\*\* (\d+)\/(\d+) tests/);
  const soFar = t.match(/\*\*So far:\*\* (\d+) passed, (\d+) failed, (\d+) flaky, (\d+) skipped/);
  const stats = t.match(/\*\*Stats:\*\* (\d+) passed, (\d+) failed, (\d+) skipped(?:, (\d+) flaky)?(?: · ran in ([^\n]+))?/);
  const r = { kind: 'playwright', state: 'unknown', passed: 0, failed: 0, flaky: 0, skipped: 0, done: 0, total: 0, duration: '', aborted: false, failedTests: [], flakyTests: [] };
  if (/Playwright E2E tests were \*\*skipped\*\*/.test(t)) r.state = 'skipped';
  else if (running) {
    Object.assign(r, { state: 'running', done: num(running[1]), total: num(running[2]) });
    if (soFar) Object.assign(r, { passed: num(soFar[1]), failed: num(soFar[2]), flaky: num(soFar[3]), skipped: num(soFar[4]) });
  } else if (stats) {
    Object.assign(r, { passed: num(stats[1]), failed: num(stats[2]), skipped: num(stats[3]), flaky: num(stats[4]), duration: (stats[5] || '').trim() });
    r.state = r.failed ? 'failed' : 'passed';
    r.total = r.passed + r.failed + r.skipped + r.flaky;
    r.done = r.total;
  }
  r.aborted = /Aborted early after \d+ failures/.test(t);
  // The comment doesn't name its commit; its run does, looked up by run ID:
  // a `run-id: N` marker, else the last Actions run it links.
  r.run = t.match(/\brun-id: (\d+)/)?.[1] || lastRun(t);
  r.sha = '';
  const test = (line) => line.match(/^- (?::x: )?\*\*(.+?)\*\* \(`(.+?)`\)/);
  for (const s of sections(t)) {
    const list = /^(Failed Tests|Failing so far)/.test(s.heading) ? r.failedTests : /Flaky/.test(s.heading) ? r.flakyTests : null;
    if (!list) continue;
    for (const line of s.body.split('\n')) {
      const m = test(line);
      if (m) list.push({ title: plain(m[1]), file: m[2] });
    }
  }
  return r;
}

// The one-line form of a report: the chip text, and what notify and alert see.
export function reportSummary(r) {
  if (r.kind === 'qa') {
    const n = (k) => r.checks.filter((c) => c.kind === k).length;
    const parts = [
      r.defects.length && `🐞 ${r.defects.length} defect${r.defects.length === 1 ? '' : 's'}`,
      n('fail') && !r.defects.length && `${n('fail')} failed`,
      n('blocked') && `${n('blocked')} blocked`,
      n('flaky') && `${n('flaky')} flaky`,
      r.ux.length && `${r.ux.length} UX note${r.ux.length === 1 ? '' : 's'}`,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : r.tone === 'TIP' ? '✅ Clean' : r.verdict || 'No findings';
  }
  if (r.state === 'running') return `⏳ Running ${r.done}/${r.total}${r.failed ? ` · ${r.failed} failed so far` : ''}`;
  if (r.state === 'skipped') return 'Skipped';
  if (r.state === 'unknown') return 'No results yet';
  const counts = [r.failed && `${r.failed} failed`, r.flaky && `${r.flaky} flaky`].filter(Boolean);
  return `${r.state === 'failed' ? '❌' : '✅'} ${r.passed}/${r.total - r.skipped} passed${counts.length ? ` · ${counts.join(' · ')}` : ''}`;
}

function reportReason(r) {
  if (r.kind === 'qa') return r.defects.length ? `${r.defects.length} defect${r.defects.length === 1 ? '' : 's'}` : reportSummary(r);
  return r.failed ? `${r.failed} failed${r.state === 'running' ? ' so far' : ''}` : reportSummary(r);
}

const PARSERS = { qa: parseQaReport, playwright: parsePlaywrightReport };

// The last Actions run linked from a text (the QA comment's "workflow run" footer).
const lastRun = (t) => [...t.matchAll(/\/actions\/runs\/(\d+)/g)].pop()?.[1] || '';

const sameCommit = (a, b) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
};

// { name: commit } for each value made for a commit other than the PR's
// latest. A value whose commit isn't known yet (a run not looked up) isn't
// called stale.
export function staleFor(row) {
  return Object.fromEntries(
    Object.entries(row.madeFor || {})
      .filter(([, m]) => m.sha && row.sha && !sameCommit(m.sha, row.sha))
      .map(([n, m]) => [n, m.sha]),
  );
}

// Fills in the commits of values known only by their Actions run (from
// `shaByRun`, run ID → commit), then re-marks staleness and "needs you".
export function applyRunCommits(row, shaByRun, config) {
  for (const m of Object.values(row.madeFor || {})) if (!m.sha && m.run && shaByRun[m.run]) m.sha = shaByRun[m.run];
  row.staleReports = staleFor(row);
  row.attention = attention(row, config);
  return row;
}

function extract(pr, ex) {
  if (ex.report) {
    // A report reads the newest text holding the marker, not every match.
    const t = texts(pr, ex.source || 'comments', ex.contains).pop();
    if (!t) return { values: [], run: '' };
    const report = { ...PARSERS[ex.report](t.body), url: t.url };
    const run = ex.artifacts ? lastRun(t.body) : '';
    return { values: [reportSummary(report)], run, report, madeFor: { sha: report.sha, run: report.run } };
  }
  const re = new RegExp(ex.regex, 'g');
  const found = [];
  let source = '';
  for (const { body: t } of texts(pr, ex.source || 'all', ex.contains)) {
    for (const m of t.matchAll(re)) {
      found.push((m[1] ?? m[0]).trim());
      source = t;
    }
  }
  // The Actions run linked from the text the newest value came from (the QA
  // comment's "workflow run" footer), whose artifacts the chip downloads.
  // The footer comes last, so the last run link wins over any in the body.
  const run = ex.artifacts ? lastRun(source) : '';
  const sha = ex.commit && found.length ? [...source.matchAll(new RegExp(ex.commit, 'g'))].pop()?.[1] || '' : '';
  const madeFor = sha ? { sha, run: '' } : undefined;
  const shown = found.map((v) => ex.show?.[v] ?? v);
  if (ex.all) return { values: [...new Set(shown)], run, madeFor };
  return { values: shown.length ? [shown[shown.length - 1]] : [], run, madeFor };
}

// `contexts` defaults to the check runs in the GraphQL response; the service
// worker passes Actions jobs instead when those runs are hidden.
export function normalize(pr, config, contexts = flattenContexts(pr)) {
  config = profileFor(config, pr.repository.nameWithOwner);
  const labelCfg = Object.fromEntries(config.labels.map((l) => [l.name, l]));
  const labels = nodes(pr.labels)
    .filter((l) => labelCfg[l.name] || config.showOtherLabels)
    .map((l) => ({ name: l.name, color: l.color, kind: labelCfg[l.name]?.kind || 'info' }));
  const checks = config.checks.map((c) => {
    const re = new RegExp(c.match);
    const runs = contexts.filter((x) => re.test(x.name));
    const hit = !runs.length ? null : c.rollup ? rollup(runs) : pickCheck(runs);
    return {
      label: c.label,
      state: hit ? hit.state : 'missing',
      title: c.showTitle && hit ? hit.title : '',
      url: hit?.url || '',
    };
  });
  const results = config.extractors.map((ex) => [ex.name, extract(pr, ex)]);
  const extracted = Object.fromEntries(results.map(([n, r]) => [n, r.values]));
  const artifactRuns = Object.fromEntries(results.filter(([, r]) => r.run).map(([n, r]) => [n, r.run]));
  const reports = Object.fromEntries(results.filter(([, r]) => r.report).map(([n, r]) => [n, r.report]));
  const madeFor = Object.fromEntries(results.filter(([, r]) => r.madeFor && (r.madeFor.sha || r.madeFor.run)).map(([n, r]) => [n, r.madeFor]));
  const row = {
    key: `${pr.repository.nameWithOwner}#${pr.number}`,
    id: pr.id,
    sha: pr.headRefOid || '',
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login || '',
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    updatedAt: pr.updatedAt,
    labels,
    allLabels: nodes(pr.labels).map((l) => l.name),
    checks,
    extracted,
    artifactRuns,
    reports,
    madeFor,
  };
  row.staleReports = staleFor(row);
  row.attention = attention(row, config);
  return row;
}

export function attention(row, config) {
  config = profileFor(config, row.repo);
  const reasons = [];
  for (const l of row.labels) if (l.kind === 'alert') reasons.push(l.name);
  const a = config.attention || {};
  config.checks.forEach((c, i) => {
    const got = row.checks[i];
    if (a.failedChecks && got.state === 'fail') reasons.push(`${c.label} failed`);
    if (c.alertTitle && got.title && new RegExp(c.alertTitle).test(got.title)) reasons.push(`${c.label}: ${got.title}`);
  });
  for (const ex of config.extractors) {
    if (!ex.alert) continue;
    for (const v of row.extracted[ex.name] || []) {
      if (!new RegExp(ex.alert).test(v)) continue;
      // A report's block already shows its summary, so the reason names only the cause.
      const r = row.reports?.[ex.name];
      const stale = row.staleReports?.[ex.name] ? ' (stale)' : '';
      reasons.push(r ? `${ex.name}: ${reportReason(r)}${stale}` : `${ex.name}: ${v}${stale}`);
    }
  }
  if (a.changesRequested && row.reviewDecision === 'CHANGES_REQUESTED') reasons.push('Changes requested');
  if (a.conflicts && row.mergeable === 'CONFLICTING') reasons.push('Merge conflict');
  return reasons;
}

const STATE_WORD = { pass: 'passed', fail: 'failed', cancelled: 'cancelled', neutral: 'finished' };

// Returns one {key, title, message, url} per PR that changed in a way the
// config marks notify. An empty `prev` (first run, fresh install) yields
// nothing, so installing doesn't fire a notification per open PR.
// Why a PR is being watched: 'manual' (its bell), 'auto' (a check that
// notifies is running, or a report that notifies is still in progress), or
// null.
export function watchReason(row, config, manual = new Set()) {
  if (manual.has(row.key)) return 'manual';
  if (config.autoWatch === false) return null;
  const p = profileFor(config, row.repo);
  const checkRunning = p.checks.some((c, i) => c.notify && row.checks[i]?.state === 'pending');
  const reportRunning = p.extractors.some((ex) => ex.notify && row.reports?.[ex.name]?.state === 'running');
  return checkRunning || reportRunning ? 'auto' : null;
}

// The PRs watched by bell: their own bells, plus every PR in a group whose
// bell is rung, including PRs that join the group later, minus the ones
// unwatched one by one from such a group.
export function watchedKeys(snapshot, { watched = [], watchedGroups = [], unwatched = [] } = {}) {
  const out = new Set(watched);
  const skip = new Set(unwatched);
  for (const s of snapshot?.sections || []) {
    if (watchedGroups.includes(s.title)) for (const k of s.keys) if (!skip.has(k)) out.add(k);
  }
  return out;
}

// `everything`: keys of PRs watched with their bell, for which every check,
// label and extracted value notifies, not only the ones marked notify.
// How a notification reads at a glance, shared by the panel's notification
// list and the Mac app's cards: the PR out of its "owner/repo#N title" title,
// and a tone per message line (one changed thing each), worst first.
const NOTICE_TONES = [
  ['fail', /fail|error|cancel|blocked|not recommended|stale|closed/i],
  ['pending', /running|queued|pending|requested|in progress|started/i],
  ['pass', /pass|success|ready|clean|merged|approved/i],
];
export function readNotice({ title = '', message = '' }) {
  const pr = title.match(/^(\S+?)\/(\S+?)#(\d+) (.*)$/s);
  const lines = message
    .split('\n')
    .filter(Boolean)
    .map((text) => ({ text, tone: NOTICE_TONES.find(([, re]) => re.test(text))?.[0] || '' }));
  const tone = ['fail', 'pending', 'pass'].find((t) => lines.some((l) => l.tone === t)) || '';
  return { pr: pr ? { repo: `${pr[1]}/${pr[2]}`, name: pr[2], number: Number(pr[3]) } : null, title: pr ? pr[4] : title, lines, tone };
}

// PRs that left the list because they were merged or closed, kept for the
// badges: a session or preview page then shows "#123 merged" instead of
// nothing. `left` are the rows that just left, `states` GitHub's state for
// each by key; a PR back in the list (`keys`) is dropped.
export const ENDED_DAYS = 14;
const ENDED_MAX = 200;
export function settleEnded(ended, left, keys, states, now = Date.now()) {
  const next = Object.fromEntries(Object.entries(ended || {}).filter(([key, r]) => !keys.has(key) && now - r.endedAt < ENDED_DAYS * 86_400_000));
  for (const row of left) {
    const state = states[row.key];
    if (state !== 'MERGED' && state !== 'CLOSED') continue;
    next[row.key] = { ...row, ended: state, endedAt: now, attention: [], staleReports: {} };
  }
  return Object.fromEntries(
    Object.entries(next)
      .sort(([, a], [, b]) => b.endedAt - a.endedAt)
      .slice(0, ENDED_MAX),
  );
}

const LEFT_WORD = { MERGED: 'Merged', CLOSED: 'Closed', OPEN: 'No longer matches your searches' };

export function diff(prev, next, config, everything = new Set(), states = {}) {
  if (!prev || !prev.length) return [];
  const before = Object.fromEntries(prev.map((r) => [r.key, r]));
  const after = new Set(next.map((r) => r.key));
  const events = [];
  const base = config;
  for (const row of next) {
    const old = before[row.key];
    config = profileFor(base, row.repo);
    const all = everything.has(row.key);
    const notifyLabels = new Set(config.labels.filter((l) => l.notify).map((l) => l.name));
    const lines = [];
    if (!old) {
      lines.push('New in your list');
    } else {
      for (const name of row.allLabels) {
        if ((all || notifyLabels.has(name)) && !old.allLabels.includes(name)) lines.push(`Label: ${name}`);
      }
      config.checks.forEach((c, i) => {
        const a = old.checks[i];
        const b = row.checks[i];
        if (!(c.notify || all) || !a || !b) return;
        if (a.state !== b.state && STATE_WORD[b.state]) lines.push(`${c.label} ${STATE_WORD[b.state]}${b.title ? `: ${b.title}` : ''}`);
        else if (b.title && a.title !== b.title) lines.push(`${c.label}: ${b.title}`);
      });
      for (const ex of config.extractors) {
        if (!(ex.notify || all)) continue;
        const a = (old.extracted[ex.name] || []).join('\n');
        const b = (row.extracted[ex.name] || []).join('\n');
        if (b && a !== b) lines.push(`${ex.name}: ${b}`);
      }
      if (old.isDraft && !row.isDraft) lines.push('Marked ready for review');
    }
    if (lines.length) events.push({ key: row.key, title: `${row.key} ${row.title}`, message: lines.join('\n'), url: row.url });
  }
  for (const old of prev) {
    if (!after.has(old.key)) {
      events.push({ key: old.key, title: `${old.key} ${old.title}`, message: LEFT_WORD[states[old.key]] || 'Left your list (merged or closed?)', url: old.url });
    }
  }
  return events;
}

const FIELD_HINT = {
  commits: 'needs Contents: read on a fine-grained token',
  statusCheckRollup: "fine-grained tokens can't read check runs; with checksSource auto the panel reads Actions jobs instead",
  contexts: "fine-grained tokens can't read check runs; with checksSource auto the panel reads Actions jobs instead",
  comments: 'needs Issues + Pull requests read',
  reviews: 'needs Pull requests read',
  labels: 'needs Issues + Pull requests read',
};

// The fields a fine-grained token is refused because it can't call the
// Checks API; the Actions API fallback replaces exactly these.
const CHECK_FIELDS = ['commits', 'statusCheckRollup', 'contexts'];
export const touchesChecks = (e) => e.path?.some((p) => CHECK_FIELDS.includes(p));

// Collapses GraphQL's one-error-per-node into one line per blocked field, e.g.
// "Can't read statusCheckRollup on 20 PRs (…hint): Resource not accessible…".
export function summarizeErrors(errors) {
  // One PR with 30 hidden check runs is 30 errors; count PRs, which are the
  // search index in the path (search.nodes[i]), not errors.
  const groups = new Map();
  for (const [i, e] of errors.entries()) {
    const field = (e.path || []).filter((p) => typeof p === 'string' && p !== 'nodes').pop() || 'query';
    const key = `${field}\u0000${e.message}`;
    const pr = e.path?.[0] === 'search' && Number.isInteger(e.path[2]) ? e.path[2] : `error ${i}`;
    groups.set(key, (groups.get(key) || new Set()).add(pr));
  }
  return [...groups]
    .map(([key, prs]) => {
      const n = prs.size;
      const [field, message] = key.split('\u0000');
      const hint = FIELD_HINT[field] ? ` (${FIELD_HINT[field]})` : '';
      return `Can't read ${field} on ${n} PR${n === 1 ? '' : 's'}${hint}: ${message}`;
    })
    .join('\n');
}

// True when `url` is `base` or a page under it: a PR's /files tab matches
// its PR, but .../pull/49 never matches .../pull/4977.
export function within(url, base) {
  return url === base || (url.startsWith(base) && '/?#'.includes(url[base.length]));
}

// The PRs a tab belongs to: the PR page itself, or a page linked from the PR
// by a link extractor (a Claude session, the preview).
export function rowsForUrl(rows, url, config) {
  if (!url) return [];
  const linkNames = (r) => profileFor(config, r.repo).extractors.filter((e) => e.kind === 'link').map((e) => e.name);
  // A Claude Code session is the same session at any URL carrying its ID
  // (another path, a query, a trailing slash), so session links match on it.
  const session = sessionId(url);
  const same = (v) => within(url, v) || (session && sessionId(v) === session);
  return rows.filter((r) => within(url, r.url) || linkNames(r).some((n) => (r.extracted[n] || []).some(same)));
}

// The `session_…` ID in a Claude Code URL, or ''.
export const sessionId = (url) => url.match(/\bsession_[A-Za-z0-9]+/)?.[0] || '';

// Turns a configured action into {title, action}; label actions become one
// setLabels write, and null hides a button whose label is already in the
// state it would set.
export function actionButton(a, has) {
  if (!a.type.endsWith('Label')) return { title: a.title, action: a };
  const adding = a.type === 'addLabel' || (a.type === 'toggleLabel' && !has(a.label));
  if (a.type === 'addLabel' && has(a.label)) return null;
  if (a.type === 'removeLabel' && !has(a.label)) return null;
  const title = a.type === 'toggleLabel' ? `${adding ? '+' : '−'} ${a.title}` : a.title;
  return { title, action: { type: 'setLabels', [adding ? 'add' : 'remove']: [a.label] } };
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The settings form shows a check's `match` regex as the plain check name
// when it is an exact-name match, * for every check, and /pattern/ otherwise.
export function regexToName(re) {
  if (re === '.') return '*';
  const exact = re.match(/^\^(.*)\$$/);
  if (exact) {
    const name = exact[1].replace(/\\(.)/g, '$1');
    if (escapeRe(name) === exact[1]) return name;
  }
  return `/${re}/`;
}

export function nameToRegex(text) {
  const t = text.trim();
  if (t === '*') return '.';
  return t.length > 1 && t.startsWith('/') && t.endsWith('/') ? t.slice(1, -1) : `^${escapeRe(t)}$`;
}

// Runs `fn` over `items` with at most `limit` in flight, keeping order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Which open tab to reuse for `url`: one showing exactly that page, else one
// showing a page under it (a PR's Files or Checks tab), else none.
export function tabFor(tabs, url) {
  const base = url.split(/[?#]/)[0];
  const page = (t) => (t.url || '').split(/[?#]/)[0];
  const session = sessionId(url);
  return (
    tabs.find((t) => page(t) === base) ||
    tabs.find((t) => within(page(t), base)) ||
    // A Claude session is the same session at any URL carrying its ID.
    (session && tabs.find((t) => sessionId(t.url || '') === session)) ||
    null
  );
}

// Every Claude Code session link in some texts, once each.
export function sessionLinksIn(texts) {
  const re = new RegExp(SESSIONS.regex, 'g');
  return [...new Set(texts.flatMap((t) => (t || '').match(re) || []))];
}

// The session links a polled PR carries, from whichever extractors found them.
export const rowSessions = (row) => sessionLinksIn(Object.values(row.extracted || {}).flat());

export function validateConfig(cfg) {
  const errors = [];
  if (!Array.isArray(cfg.queries)) errors.push('"queries" must be an array');
  if (cfg.watchSeconds !== undefined && !(Number(cfg.watchSeconds) >= 5)) errors.push('watchSeconds must be 5 or more');
  if (cfg.checksSource && !['auto', 'checks', 'actions'].includes(cfg.checksSource)) errors.push('checksSource must be auto, checks or actions');
  for (const q of cfg.queries || []) if (!q.q?.trim()) errors.push(`search "${q.title || '(untitled)'}" has no GitHub search`);
  for (const p of cfg.badgePages || []) if (!/^https:\/\/(\*\.)?[\w.-]+\/\*$/.test(p.match || '')) errors.push(`badge page "${p.match || ''}" must look like https://*.example.com/*`);
  const repos = Object.entries(cfg.repos || {});
  if (!repos.length) errors.push('Add at least one repo: only repos that are set up are tracked.');
  for (const [repo, p] of repos) {
    const bad = (msg) => errors.push(`${repo}: ${msg}`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) bad('not an owner/name repo');
    for (const k of PROFILE_KEYS) if (!Array.isArray(p[k])) bad(`"${k}" must be an array`);
    for (const l of p.labels || []) if (!l.name?.trim()) bad('a watched label has no name');
    for (const c of p.checks || []) {
      if (!c.match) bad(`check "${c.label || '(unnamed)'}" has no check name`);
      try {
        new RegExp(c.match);
      } catch (e) {
        bad(`check "${c.label}": bad regex (${e.message})`);
      }
    }
    for (const ex of p.extractors || []) {
      if (ex.report && !PARSERS[ex.report]) bad(`extractor "${ex.name}": unknown report ${ex.report}`);
      if (!ex.report && !ex.regex) bad(`extractor "${ex.name}" has no pattern`);
      try {
        new RegExp(ex.regex);
        if (ex.alert) new RegExp(ex.alert);
        if (ex.commit) new RegExp(ex.commit);
      } catch (e) {
        bad(`extractor "${ex.name}": bad regex (${e.message})`);
      }
    }
    for (const a of p.actions || []) {
      if (!['addLabel', 'removeLabel', 'toggleLabel', 'markReady', 'convertToDraft', 'close'].includes(a.type)) bad(`action "${a.title}": unknown type ${a.type}`);
    }
  }
  return errors;
}
