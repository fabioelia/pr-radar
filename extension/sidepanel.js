import { h, icon } from './dom.js';
import { jobLog, listLabels, prChecks } from './github.js';
import { actionButton, mergeConfig, profileFor, readNotice, rowsForUrl, watchReason, watchedKeys } from './lib.js';

const STATE_TEXT = { pass: 'passed', fail: 'failed', pending: 'running', neutral: 'neutral', cancelled: 'cancelled', skipped: 'skipped' };
const $ = (id) => document.getElementById(id);
let state = { snapshot: null, config: mergeConfig(), currentUrl: '', expanded: new Set(), needsOnly: false, watched: new Set(), lists: {} };

// Collapsed sections and cards are a per-viewer convenience, so
// localStorage is enough; it can be unavailable, and the panel works the
// same without it.
function persistedSet(key) {
  let initial = [];
  try {
    initial = JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    /* storage blocked: start empty */
  }
  const set = new Set(initial);
  set.save = () => {
    try {
      localStorage.setItem(key, JSON.stringify([...set]));
    } catch {
      /* storage blocked: collapse just won't persist */
    }
  };
  return set;
}
const collapsed = persistedSet('collapsed');
const shutCards = persistedSet('collapsedCards');

function setCardShut(keys, shut) {
  for (const k of keys) shut ? shutCards.add(k) : shutCards.delete(k);
  shutCards.save();
  render();
}

const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

const link = (href, attrs, ...children) => h('a', { href, target: '_blank', rel: 'noopener', ...attrs }, ...children);
const dot = (s) => h('span', { class: `dot ${s}` });

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => {
    if (!r?.ok) throw new Error(r?.error || 'failed');
  });
}

// Writes go to GitHub under your name, so every one takes a second click.
// The armed state lives here, keyed by `id`, not on the button: a poll or a
// refresh re-renders the panel between the two clicks, and a fresh button
// must still remember the first one.
let armed = { id: null, until: 0 };
function confirmButton(text, run, id, cls = 'ghost sm') {
  const btn = h('button', { class: cls }, text);
  const arm = (on) => {
    btn.textContent = on ? `Confirm ${text}?` : text;
    btn.classList.toggle('confirm', on);
  };
  if (armed.id === id && Date.now() < armed.until) arm(true);
  btn.addEventListener('click', async () => {
    if (armed.id !== id || Date.now() >= armed.until) {
      armed = { id, until: Date.now() + 4000 };
      arm(true);
      setTimeout(() => armed.id === id && Date.now() >= armed.until && arm(false), 4100);
      return;
    }
    armed = { id: null, until: 0 };
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await run();
      btn.textContent = 'Done';
    } catch (e) {
      arm(false);
      btn.disabled = false;
      showError(e.message);
    }
  });
  return btn;
}

function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg || '';
}

const shortSession = (url) => `Session ${url.split('session_')[1]?.slice(0, 6) || ''}`;
const hexColor = (c) => (/^[0-9a-f]{6}$/i.test(c || '') ? `#${c}` : '');

function checkPill(row, c) {
  const pill = h(
    c.url ? 'a' : 'span',
    { class: `pill ${c.state}`, href: c.url || undefined, target: c.url ? '_blank' : undefined, title: `${c.label}: ${STATE_TEXT[c.state] || c.state}${c.title ? ` — ${c.title}` : ''}` },
    dot(c.state),
    c.label,
    c.title ? h('span', { class: 't' }, c.title) : null,
  );
  if (c.state !== 'fail' || !/\/job\/\d+/.test(c.url)) return pill;
  const rerun = confirmButton('Re-run', () => send({ type: 'act', action: { type: 'rerunJob' }, row, jobUrl: c.url }), `${row.key}|rerun|${c.label}`, 'rerun');
  return h('span', { class: 'pill fail' }, dot('fail'), c.url ? link(c.url, { class: 'plain' }, c.label) : c.label, rerun);
}

function labelPill(l) {
  const color = hexColor(l.color);
  return h('span', { class: `pill label ${l.kind}` }, h('span', { class: 'dot', style: color ? `background:${color}` : undefined }), l.name);
}

function downloadButton(row, name) {
  const btn = h('button', { class: 'ghost sm', title: "Download this run's artifacts" }, icon('download', 13), 'Screenshots');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await send({ type: 'download', row, extractor: name });
    } catch (e) {
      showError(e.message);
    }
    btn.disabled = false;
  });
  return btn;
}

const MAX_ITEMS = 8;
function itemList(items, url) {
  const shown = items.slice(0, MAX_ITEMS);
  const more = items.length - shown.length;
  return h(
    'ul',
    {},
    shown.map(([k, cls, text]) => h('li', {}, h('span', { class: `k ${cls}` }, k), h('span', {}, text))),
    more > 0 ? h('li', {}, link(url, {}, `+${more} more in the comment`)) : null,
  );
}

// Marks a value made for an older commit than the PR's latest push.
function staleTag(row, name) {
  const sha = row.staleReports?.[name];
  if (!sha) return null;
  return h('span', { class: 'tag-sm warn stale', title: `Made for commit ${sha.slice(0, 7)}; the PR is now at ${row.sha.slice(0, 7)}, so this may not reflect the latest push.` }, 'stale');
}

function qaBlock(row, name, r) {
  const items = [
    ...r.defects.map((d) => [`${d.id} · ${d.severity}`, d.severity, d.title]),
    ...r.checks.map((c) => [c.kind, c.kind, c.title]),
    ...r.ux.map((u) => [u.id, 'ux', u.title]),
  ];
  return h(
    'div',
    { class: 'report' },
    h(
      'div',
      { class: 'report-head' },
      dot(r.defects.length || r.checks.some((c) => c.kind === 'fail') ? 'fail' : r.tone === 'TIP' ? 'pass' : 'neutral'),
      name,
      h('span', { class: 't' }, r.verdict),
      row.artifactRuns?.[name] ? downloadButton(row, name) : null,
      staleTag(row, name),
      link(r.url, {}, 'Report', icon('external', 12)),
    ),
    items.length ? itemList(items, r.url) : null,
  );
}

function playwrightBlock(row, name, r) {
  const counts = [
    ['fail', r.failed, 'failed'],
    ['pending', r.flaky, 'flaky'],
    ['pass', r.passed, 'passed'],
    ['skipped', r.skipped, 'skipped'],
  ].filter(([, n]) => n);
  const head =
    r.state === 'running'
      ? `Running ${r.done} of ${r.total}`
      : r.state === 'skipped'
        ? 'Skipped for this PR'
        : r.state === 'unknown'
          ? 'No results yet'
          : `${r.passed + r.failed + r.flaky} of ${r.total} ran${r.duration ? ` · ${r.duration}` : ''}${r.aborted ? ' · stopped early' : ''}`;
  const items = [...r.failedTests.map((t) => ['fail', 'fail', t.title]), ...r.flakyTests.map((t) => ['flaky', 'flaky', t.title])];
  return h(
    'div',
    { class: 'report' },
    h('div', { class: 'report-head' }, dot(r.state === 'failed' ? 'fail' : r.state === 'running' ? 'pending' : r.state === 'passed' ? 'pass' : 'neutral'), name, h('span', { class: 't' }, head), staleTag(row, name), link(r.url, {}, 'Results', icon('external', 12))),
    counts.length ? h('div', { class: 'counts' }, counts.map(([s, n, label]) => h('span', { class: `pill ${s === 'pass' || s === 'skipped' ? '' : s}` }, dot(s), `${n} ${label}`))) : null,
    items.length ? itemList(items, r.url) : null,
  );
}

function cardClass(row, current, extra) {
  const running = row.checks.some((c) => c.state === 'pending');
  return ['card', extra, row.attention.length ? 'needs' : running ? 'running' : '', row.isDraft && 'draft', current && 'current'].filter(Boolean).join(' ');
}

// A collapsed card: one line with the title, number and a dot per check.
function compactCard(row, current) {
  const dots = row.checks.filter((c) => c.state !== 'missing').map((c) => h('span', { class: `dot ${c.state}`, title: `${c.label}: ${STATE_TEXT[c.state] || c.state}` }));
  const el = h(
    'article',
    { class: cardClass(row, current, 'compact'), 'data-key': row.key, title: [row.title, ...row.attention].join('\n') },
    h(
      'div',
      { class: 'card-head' },
      link(row.url, { class: 'title' }, row.title),
      dots.length ? h('span', { class: 'mini-dots' }, dots) : null,
      watchBits(row).live,
      h('span', { class: 'num' }, `#${row.number}`),
      h('button', { class: 'ghost icon sm fold', title: 'Expand', 'aria-label': `Expand #${row.number}`, 'aria-expanded': 'false', onclick: () => setCardShut([row.key], false) }, icon('chevron', 14)),
    ),
  );
  el.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    setCardShut([row.key], false);
  });
  return el;
}

// The bell: watch a PR, so it is checked every watchSeconds and every change
// notifies. The background picks the list up from storage.
// The bells. A card's bell watches one PR; a group's bell watches every PR
// in the group, including ones that join it later (watchedGroups), and a
// card bell turned off inside a watched group is remembered as an exception
// (unwatched). The background reads the same three lists.
async function saveLists(lists) {
  await chrome.storage.local.set({ watched: [...lists.watched], watchedGroups: [...lists.watchedGroups], unwatched: [...lists.unwatched] });
}

function listsCopy() {
  const { watched = [], watchedGroups = [], unwatched = [] } = state.lists;
  return { watched: new Set(watched), watchedGroups: new Set(watchedGroups), unwatched: new Set(unwatched) };
}

const groupsOf = (key) => (state.snapshot?.sections || []).filter((s) => s.keys.includes(key)).map((s) => s.title);

function toggleWatch(row) {
  const l = listsCopy();
  const inWatchedGroup = groupsOf(row.key).some((t) => l.watchedGroups.has(t));
  if (state.watched.has(row.key)) {
    l.watched.delete(row.key);
    if (inWatchedGroup) l.unwatched.add(row.key);
  } else {
    l.unwatched.delete(row.key);
    if (!inWatchedGroup) l.watched.add(row.key);
  }
  return saveLists(l);
}

function toggleGroup(section) {
  const l = listsCopy();
  if (l.watchedGroups.has(section.title)) {
    l.watchedGroups.delete(section.title);
    for (const k of section.keys) {
      l.watched.delete(k);
      l.unwatched.delete(k);
    }
  } else {
    l.watchedGroups.add(section.title);
    for (const k of section.keys) l.unwatched.delete(k);
  }
  return saveLists(l);
}

// Lit when the group is watched; half-lit when it is watched with
// exceptions, or not watched but some of its PRs are.
function groupBell(section) {
  const groupOn = (state.lists.watchedGroups || []).includes(section.title);
  const watched = section.keys.filter((k) => state.watched.has(k)).length;
  const full = groupOn && watched === section.keys.length;
  const some = !full && watched > 0;
  const seconds = state.config.watchSeconds || 30;
  return h(
    'button',
    {
      class: `ghost icon sm bell${full ? ' on' : some ? ' some' : ''}`,
      'aria-pressed': full ? 'true' : some ? 'mixed' : 'false',
      'aria-label': groupOn ? `Stop watching ${section.title}` : `Watch ${section.title}`,
      title: groupOn
        ? `Watching every PR in ${section.title}, new ones included${full ? '' : ` (${section.keys.length - watched} turned off one by one)`}. Click to stop watching them all.`
        : `Watch every PR in ${section.title}, new ones included: check every ${seconds}s and notify on every change${watched ? ` (${watched} already watched)` : ''}`,
      onclick: () => toggleGroup(section),
    },
    icon('bell', 13),
  );
}

function watchBits(row) {
  const reason = watchReason(row, state.config, state.watched);
  const seconds = state.config.watchSeconds || 30;
  const live = reason
    ? h('span', { class: 'tag-sm live', title: reason === 'manual' ? `Watching: checked every ${seconds}s, and every change notifies you.` : `A check you get notified about is running: checked every ${seconds}s until it lands.` }, h('span', { class: 'dot pending' }), 'live')
    : null;
  const on = reason === 'manual';
  const bell = h(
    'button',
    { class: `ghost icon sm bell${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': on ? `Stop watching #${row.number}` : `Watch #${row.number}`, title: on ? 'Stop watching' : `Watch: check every ${seconds}s and notify on every change`, onclick: () => toggleWatch(row) },
    icon('bell', 14),
  );
  return { live, bell };
}

function card(row, current) {
  if (shutCards.has(row.key)) return compactCard(row, current);
  const { live, bell } = watchBits(row);
  const config = profileFor(state.config, row.repo);
  const open = state.expanded.has(row.key);
  // A check with no data on this PR (a draft without a preview, a check
  // the token can't see) is noise, so it isn't drawn.
  const checks = row.checks.filter((c) => c.state !== 'missing').map((c) => checkPill(row, c));
  const tags = [
    ...row.labels.map(labelPill),
    ...config.extractors
      .filter((ex) => !ex.report)
      .flatMap((ex) =>
        (row.extracted[ex.name] || []).map((v) =>
          ex.kind === 'link'
            ? link(v, { class: 'pill link', title: v }, icon('link', 12), v.includes('claude.ai/code/session_') ? shortSession(v) : ex.name, staleTag(row, ex.name))
            : h('span', { class: 'pill', title: v }, `${ex.name}`, h('span', { class: 't' }, v), staleTag(row, ex.name)),
        ),
      ),
  ];
  const reports = config.extractors
    .filter((ex) => ex.report && row.reports?.[ex.name])
    .map((ex) => (ex.report === 'qa' ? qaBlock(row, ex.name, row.reports[ex.name]) : playwrightBlock(row, ex.name, row.reports[ex.name])));
  const has = (label) => row.allLabels.includes(label);
  const actions = config.actions
    .filter((a) => !a.when || (a.when === 'draft') === row.isDraft)
    .map((a) => ({ a, b: actionButton(a, has) }))
    .filter(({ b }) => b)
    .map(({ a, b }) => confirmButton(b.title, () => send({ type: 'act', action: b.action, row }), `${row.key}|${b.title}`, a.type === 'close' ? 'ghost sm danger' : 'ghost sm'));
  const el = h(
    'article',
    {
      class: cardClass(row, current, open && 'open'),
      'data-key': row.key,
    },
    h(
      'div',
      { class: 'card-head' },
      link(row.url, { class: 'title', title: row.title }, row.title),
      h('span', { class: 'num' }, `#${row.number}`),
      h('button', { class: 'ghost icon sm fold', title: 'Collapse', 'aria-label': `Collapse #${row.number}`, 'aria-expanded': 'true', onclick: () => setCardShut([row.key], true) }, icon('chevron', 14)),
    ),
    h(
      'div',
      { class: 'meta' },
      h('span', {}, row.repo.split('/')[1]),
      h('span', { class: 'sep' }),
      h('span', {}, row.author),
      h('span', { class: 'sep' }),
      h('span', {}, ago(row.updatedAt)),
      row.isDraft ? h('span', { class: 'tag-sm' }, 'Draft') : null,
      live,
      row.stale ? h('span', { class: 'tag-sm warn', title: "GitHub's Actions API failed on the last refresh" }, 'checks from last refresh') : null,
    ),
    row.attention.length ? h('div', { class: 'reason' }, icon('alert', 13), row.attention.join(' · ')) : null,
    checks.length ? h('div', { class: 'pills' }, checks) : null,
    tags.length ? h('div', { class: 'pills' }, tags) : null,
    reports,
    h(
      'div',
      { class: 'card-foot' },
      actions.slice(0, INLINE_ACTIONS),
      h('span', { class: 'spacer' }),
      bell,
      moreMenu(row, actions.slice(INLINE_ACTIONS)),
      h('button', { class: 'ghost sm expand', 'aria-expanded': String(open), onclick: () => toggleOpen(row) }, 'Checks', icon('chevron', 13)),
    ),
    state.picker?.key === row.key ? picker(row) : null,
    open ? details(row) : null,
  );
  el.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, label, select, .picker, .details, .report') || getSelection().toString()) return;
    toggleOpen(row);
  });
  return el;
}

// The first buttons in a repo's list show on the card; the rest, and the
// label picker, sit under More. Reordering in settings picks which.
const INLINE_ACTIONS = 2;

function moreMenu(row, rest) {
  const open = state.menu === row.key;
  const labels = h('button', { class: 'ghost sm', onclick: () => ((state.menu = null), togglePicker(row)) }, icon('tag', 13), 'Labels…');
  return h(
    'span',
    { class: 'more' },
    h('button', { class: `ghost sm${open ? ' on' : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': String(open), onclick: () => ((state.menu = open ? null : row.key), render()) }, 'More', icon('chevron', 13)),
    open ? h('div', { class: 'menu', role: 'menu' }, labels, rest) : null,
  );
}

function toggleOpen(row) {
  state.expanded.has(row.key) ? state.expanded.delete(row.key) : state.expanded.add(row.key);
  render();
}

// Loaded on expand and again after each poll, since a poll means the checks
// may have moved. Results live outside the DOM so re-renders keep them.
const checksCache = new Map();
const logCache = new Map();

async function loadChecks(row) {
  const at = state.snapshot.fetchedAt;
  const hit = checksCache.get(row.key);
  if (hit && hit.at === at) return;
  checksCache.set(row.key, { at, data: hit?.data, loading: true });
  const { token } = await chrome.storage.local.get('token');
  try {
    checksCache.set(row.key, { at, data: await prChecks(token, row) });
  } catch (e) {
    checksCache.set(row.key, { at, data: hit?.data, error: e.message });
  }
  render();
}

async function loadLog(row, jobId) {
  logCache.set(jobId, { loading: true, shown: true });
  render();
  const { token } = await chrome.storage.local.get('token');
  try {
    logCache.set(jobId, { data: await jobLog(token, row.repo, jobId), shown: true });
  } catch (e) {
    logCache.set(jobId, { error: e.message, shown: true });
  }
  render();
}

function checkLine(c) {
  return h('div', { class: 'check-line' }, dot(c.state), c.url ? link(c.url, {}, c.name) : h('span', {}, c.name), c.title ? h('span', { class: 't' }, c.title) : null);
}

function logBlock(data) {
  const errors = new Set(data.errors);
  const pre = h(
    'pre',
    { class: 'log' },
    data.tail.split('\n').flatMap((line) => [errors.has(line.replace(/^##\[error\]/, '')) ? h('span', { class: 'err' }, line) : line, '\n']),
  );
  requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
  return pre;
}

function failure(row, c) {
  const log = c.jobId && logCache.get(c.jobId);
  const toggleLog = () => {
    if (!log) return loadLog(row, c.jobId);
    log.shown = !log.shown;
    render();
  };
  return h(
    'div',
    { class: 'failure' },
    h('div', { class: 'failure-head' }, dot(c.state), c.url ? link(c.url, {}, c.name) : h('span', {}, c.name), c.workflow ? h('span', { class: 'wf' }, c.workflow) : null),
    c.title ? h('div', { class: 'step' }, c.title) : null,
    c.annotations?.length
      ? h('ul', { class: 'annotations' }, c.annotations.map((a) => h('li', {}, h('span', { class: 'path' }, `${a.path}${a.line ? `:${a.line}` : ''}`), ' ', a.message)))
      : null,
    c.summary ? h('div', { class: 'summary' }, c.summary.length > 600 ? `${c.summary.slice(0, 600)}…` : c.summary) : null,
    h(
      'div',
      { class: 'failure-actions' },
      c.jobId ? h('button', { class: 'ghost sm', onclick: toggleLog }, icon('terminal', 13), log?.shown ? 'Hide log' : 'Log') : null,
      c.jobId ? confirmButton('Re-run job', () => send({ type: 'act', action: { type: 'rerunJob' }, row, jobUrl: c.url }), `${row.key}|rerun|${c.name}`) : null,
    ),
    log?.shown && log.loading ? h('div', { class: 'step' }, 'Loading log…') : null,
    log?.shown && log.error ? h('div', { class: 'banner error' }, log.error) : null,
    log?.shown && log.data ? logBlock(log.data) : null,
  );
}

function details(row) {
  const entry = checksCache.get(row.key);
  if (!entry || entry.at !== state.snapshot.fetchedAt) loadChecks(row);
  const pane = h('div', { class: 'details' });
  if (entry?.error) pane.append(h('div', { class: 'banner error' }, entry.error));
  const data = entry?.data;
  if (!data) {
    pane.append(h('div', { class: 'step' }, 'Loading checks…'));
    return pane;
  }
  if (data.warning) pane.append(h('div', { class: 'banner error' }, data.warning));
  if (data.note) pane.append(h('div', { class: 'banner info' }, data.note));
  const by = Object.groupBy(data.checks, (c) => (['fail', 'cancelled'].includes(c.state) ? 'bad' : c.state === 'pending' ? 'running' : 'rest'));
  const count = (k) => by[k]?.length || 0;
  pane.append(
    h(
      'div',
      { class: 'details-head' },
      count('bad') ? h('span', { class: 'pill fail' }, dot('fail'), `${count('bad')} failing`) : null,
      count('running') ? h('span', { class: 'pill pending' }, dot('pending'), `${count('running')} running`) : null,
      h('span', { class: 'pill' }, dot('pass'), `${count('rest')} other`),
      link(`${row.url}/checks`, {}, 'Checks tab', icon('external', 12)),
    ),
  );
  for (const c of by.bad || []) pane.append(failure(row, c));
  if (by.running) pane.append(h('div', { class: 'check-list' }, by.running.map(checkLine)));
  if (by.rest) pane.append(h('details', {}, h('summary', {}, `${count('rest')} passed, skipped or neutral`), h('div', { class: 'check-list' }, by.rest.map(checkLine))));
  if (!data.checks.length) pane.append(h('div', { class: 'step' }, 'No checks on the latest commit.'));
  return pane;
}

// Repo label lists, fetched once per panel session.
const labelCache = new Map();
async function repoLabels(repo) {
  if (!labelCache.has(repo)) {
    const { token } = await chrome.storage.local.get('token');
    labelCache.set(repo, listLabels(token, repo).catch((e) => (labelCache.delete(repo), Promise.reject(e))));
  }
  return labelCache.get(repo);
}

function togglePicker(row) {
  state.picker = state.picker?.key === row.key ? null : { key: row.key, filter: '', add: new Set(), remove: new Set(), labels: null };
  render();
  if (state.picker) {
    const p = state.picker;
    repoLabels(row.repo)
      .then((labels) => {
        p.labels = labels;
        render();
      })
      .catch((e) => showError(e.message));
  }
}

function picker(row) {
  const p = state.picker;
  if (!p.labels) return h('div', { class: 'picker' }, h('span', { class: 'step' }, 'Loading labels…'));
  const configured = profileFor(state.config, row.repo).labels.map((l) => l.name);
  const isOn = (n) => (row.allLabels.includes(n) || p.add.has(n)) && !p.remove.has(n);
  const rank = (n) => (row.allLabels.includes(n) ? 0 : configured.includes(n) ? 1 : 2);
  const list = h('div', { class: 'picker-list' });
  const fill = () => {
    const f = p.filter.toLowerCase();
    const labels = p.labels.filter((l) => l.name.toLowerCase().includes(f)).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    list.replaceChildren(
      ...labels.map((l) => {
        const box = h('input', { type: 'checkbox' });
        box.checked = isOn(l.name);
        box.addEventListener('change', () => {
          const was = row.allLabels.includes(l.name);
          for (const set of [p.add, p.remove]) set.delete(l.name);
          if (box.checked !== was) (box.checked ? p.add : p.remove).add(l.name);
          apply.replaceWith((apply = applyButton()));
        });
        const color = hexColor(l.color);
        return h('label', {}, box, h('span', { class: 'dot', style: color ? `background:${color}` : undefined }), l.name);
      }),
    );
  };
  const applyButton = () =>
    p.add.size || p.remove.size
      ? confirmButton(
          `Apply ${[...[...p.add].map((n) => `+${n}`), ...[...p.remove].map((n) => `−${n}`)].join(' ')}`,
          async () => {
            await send({ type: 'act', action: { type: 'setLabels', add: [...p.add], remove: [...p.remove] }, row });
            state.picker = null;
          },
          `${row.key}|apply`,
          'primary sm',
        )
      : h('span', {}, 'Tick or untick labels, then apply.');
  let apply = applyButton();
  const filter = h('input', { type: 'search', placeholder: 'Find a label', value: p.filter, 'aria-label': 'Find a label' });
  filter.addEventListener('input', () => {
    p.filter = filter.value;
    fill();
  });
  fill();
  return h('div', { class: 'picker' }, filter, list, h('div', { class: 'picker-foot' }, apply));
}

function render() {
  const { snapshot, config } = state;
  if (!snapshot) return;
  // A poll landing while you type in the label picker would rebuild it and
  // drop focus; finish the render when focus leaves the picker.
  if (document.activeElement?.closest?.('.picker')) {
    state.renderPending = true;
    return;
  }
  state.renderPending = false;
  $('refresh').classList.remove('spin');
  const every = snapshot.busy ? config.pollMinutes : config.quietPollMinutes;
  $('updated').textContent = snapshot.fetchedAt ? `Updated ${ago(snapshot.fetchedAt)} · next in ~${every}m` : '';
  $('updated').title = snapshot.busy ? 'A check is running, so the panel refreshes often.' : 'Everything has settled, so the panel refreshes less often.';
  const rest = snapshot.rate?.rest;
  const gql = snapshot.rate?.graphql;
  $('rate').textContent = Number.isFinite(rest?.remaining) ? `${rest.remaining.toLocaleString()} API calls left` : '';
  $('rate').title = [
    Number.isFinite(rest?.remaining) && `REST: ${rest.remaining.toLocaleString()} of ${rest.limit.toLocaleString()} this hour, resets at ${new Date(rest.reset).toLocaleTimeString()}`,
    Number.isFinite(gql?.remaining) && `GraphQL: ${gql.remaining.toLocaleString()} points left`,
  ]
    .filter(Boolean)
    .join('\n');
  showError(snapshot.error || snapshot.warning);
  const needs = snapshot.rows.filter((r) => r.attention.length).length;
  $('needsCount').textContent = String(needs);
  $('needsOnly').setAttribute('aria-pressed', String(state.needsOnly));
  const q = $('filter').value.trim().toLowerCase();
  const byKey = Object.fromEntries(snapshot.rows.map((r) => [r.key, r]));
  const current = new Set(rowsForUrl(snapshot.rows, state.currentUrl, config).map((r) => r.key));
  const matches = (r) =>
    (!state.needsOnly || r.attention.length) && (!q || [r.title, `#${r.number}`, r.author, r.repo, ...r.allLabels].join(' ').toLowerCase().includes(q));

  const list = $('list');
  list.replaceChildren();
  if (!snapshot.rows.length && !snapshot.error) {
    list.append(h('div', { class: 'empty-state' }, h('strong', {}, snapshot.fetchedAt ? 'No open PRs' : 'Loading…'), snapshot.fetchedAt ? 'Nothing matches your searches in the repos you track.' : ''));
    return;
  }
  for (const s of snapshot.sections) {
    const rows = s.keys.map((k) => byKey[k]).filter(matches);
    // Needs-you first, then most recently active.
    rows.sort((a, b) => (b.attention.length > 0) - (a.attention.length > 0) || (a.updatedAt < b.updatedAt ? 1 : -1));
    const shut = collapsed.has(s.title);
    const anyOpen = rows.some((r) => !shutCards.has(r.key));
    list.append(
      h(
        'div',
        { class: `section-head${shut ? ' collapsed' : ''}` },
        h(
          'button',
          {
            class: 'section-toggle',
            'aria-expanded': String(!shut),
            title: shut ? 'Show this group' : 'Hide this group',
            onclick: () => {
              shut ? collapsed.delete(s.title) : collapsed.add(s.title);
              collapsed.save();
              render();
            },
          },
          icon('chevron', 12),
          s.title,
          h('span', { class: 'count' }, String(rows.length)),
        ),
        !shut && s.keys.length ? groupBell(s) : null,
        !shut && rows.length
          ? h('button', { class: 'ghost sm', onclick: () => setCardShut(rows.map((r) => r.key), anyOpen) }, anyOpen ? 'Collapse all' : 'Expand all')
          : null,
      ),
    );
    if (shut) continue;
    if (!rows.length) list.append(h('div', { class: 'empty' }, state.needsOnly || q ? 'Nothing matches.' : 'No PRs here.'));
    for (const r of rows) list.append(card(r, current.has(r.key)));
  }
  // Scroll to the current page's PR once, when the tab changes to it, not on
  // every render: polls re-render, and you may be scrolling elsewhere.
  const target = [...current][0] || null;
  if (target && target !== state.scrolledTo) list.querySelector('.card.current')?.scrollIntoView({ block: 'nearest' });
  state.scrolledTo = target;
}

async function load() {
  const { snapshot, config, watched = [], watchedGroups = [], unwatched = [] } = await chrome.storage.local.get(['snapshot', 'config', 'watched', 'watchedGroups', 'unwatched']);
  state.snapshot = snapshot || { rows: [], sections: [], error: null };
  state.lists = { watched, watchedGroups, unwatched };
  state.watched = watchedKeys(state.snapshot, state.lists);
  const live = new Set(state.snapshot.rows.map((r) => r.key));
  if (live.size && [...shutCards].some((k) => !live.has(k))) {
    for (const k of shutCards) if (!live.has(k)) shutCards.delete(k);
    shutCards.save();
  }
  state.config = mergeConfig(config);
  render();
}

// ─── Notifications view ──────────────────────────────────────────────────
// The last 30 notifications background.js sent (notificationLog), newest
// first. Opening the view marks them read; the ones that were unread when it
// opened stay highlighted until it closes.
const notices = { log: [], seenAt: '', since: '' };
const inboxOpen = () => !$('notices').hidden;

function renderNotices() {
  const unread = notices.log.filter((n) => n.at > notices.seenAt).length;
  $('inboxCount').hidden = !unread;
  $('inboxCount').textContent = unread > 9 ? '9+' : String(unread);
  $('inbox').setAttribute('aria-pressed', String(inboxOpen()));
  $('inbox').title = unread ? `Notifications: ${unread} new` : 'Notifications';
  if (!inboxOpen()) return;
  const head = h(
    'div',
    { class: 'section-head' },
    h('span', { class: 'section-title' }, 'Notifications', h('span', { class: 'count' }, String(notices.log.length))),
    h('button', { class: 'ghost sm', onclick: () => showInbox(false) }, 'Back to PRs'),
  );
  if (!notices.log.length) {
    return $('notices').replaceChildren(
      head,
      h('div', { class: 'empty-state' }, h('strong', {}, 'No notifications yet'), 'They land here when something you chose to be notified about changes. Settings can send a test one.'),
    );
  }
  $('notices').replaceChildren(
    head,
    ...notices.log.map((n) => {
      const { pr, title, lines, tone } = readNotice(n);
      return h(
        n.url ? 'a' : 'div',
        { class: `notice ${tone}${n.at > notices.since ? ' unread' : ''}`, href: n.url || undefined, title: n.url ? `Open ${n.url}` : undefined },
        h(
          'div',
          { class: 'notice-head' },
          h('span', { class: 'notice-title' }, title),
          h('span', { class: 'when', title: new Date(n.at).toLocaleString() }, ago(n.at)),
        ),
        pr ? h('div', { class: 'notice-pr' }, `${pr.repo} #${pr.number}`) : null,
        h('ul', { class: 'notice-lines' }, ...lines.map((l) => h('li', {}, dot(l.tone || 'neutral'), h('span', {}, l.text)))),
      );
    }),
  );
}

async function markRead() {
  const at = notices.log[0]?.at;
  if (at && at > notices.seenAt) await chrome.storage.local.set({ notificationsSeenAt: at });
}

function showInbox(open) {
  if (open) notices.since = notices.seenAt;
  $('notices').hidden = !open;
  document.body.classList.toggle('inbox-open', open);
  renderNotices();
  if (open) {
    markRead();
    scrollTo(0, 0);
  }
}

async function loadNotices() {
  const { notificationLog = [], notificationsSeenAt = '' } = await chrome.storage.local.get(['notificationLog', 'notificationsSeenAt']);
  Object.assign(notices, { log: notificationLog, seenAt: notificationsSeenAt });
  renderNotices();
  // One landing while the view is open is read as it lands.
  if (inboxOpen()) markRead();
}

async function trackTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  // tab.url is only visible for hosts in host_permissions (GitHub, claude.ai).
  state.currentUrl = (tab?.url || '').split(/[?#]/)[0];
  render();
}

$('inbox').prepend(icon('inbox', 15));
$('inbox').addEventListener('click', () => showInbox(!inboxOpen()));
$('refresh').append(icon('refresh', 15));
$('settings').append(icon('settings', 15));
$('searchIcon').replaceWith(icon('search', 14));
$('refresh').addEventListener('click', () => {
  $('refresh').classList.add('spin');
  send({ type: 'refresh' }).catch((e) => {
    $('refresh').classList.remove('spin');
    showError(e.message);
  });
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('filter').addEventListener('input', render);
$('needsOnly').addEventListener('click', () => {
  state.needsOnly = !state.needsOnly;
  render();
});
// Links switch to a tab already showing them rather than opening another.
// A modified or middle click keeps the browser's own behavior.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="http"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  send({ type: 'open', url: a.href }).catch((err) => showError(err.message));
});
document.addEventListener('click', (e) => {
  if (state.menu && !e.target.closest('.more')) {
    state.menu = null;
    render();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !state.menu && inboxOpen()) return showInbox(false);
  if (e.key === 'Escape' && state.menu) {
    state.menu = null;
    render();
  }
});
document.addEventListener('focusout', () => setTimeout(() => state.renderPending && render()));
chrome.storage.onChanged.addListener((c) => (c.snapshot || c.config || c.watched || c.watchedGroups || c.unwatched) && load());
chrome.storage.onChanged.addListener((c) => (c.notificationLog || c.notificationsSeenAt) && loadNotices());
chrome.tabs.onActivated.addListener(trackTab);
chrome.tabs.onUpdated.addListener((_id, info) => info.url && trackTab());
setInterval(() => (render(), renderNotices()), 60000);
load().then(trackTab);
loadNotices();
