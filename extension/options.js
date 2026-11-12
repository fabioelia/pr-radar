import { fillSuggestions, onRepoSelected, renderBuilder, setKnownRepos } from './builder.js';
import { h } from './dom.js';
import { checkNames, diagnose, listLabels, listRepos, whoami } from './github.js';
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from './lib.js';

const $ = (id) => document.getElementById(id);
const token = () => $('token').value.trim();

// The form and the JSON tab edit the same object; whichever tab is open is
// the source of truth when switching or saving. `saved` is what storage
// holds, so the save bar can tell whether anything changed.
let cfg = structuredClone(DEFAULT_CONFIG);
let tab = 'form';
let saved = { config: '', token: '' };

function status(msg, tone = 'muted') {
  $('status').textContent = msg;
  $('status').className = tone === 'bad' ? 'bad' : 'muted';
}

const isDirty = () => (tab === 'json' ? $('config').value !== JSON.stringify(cfg, null, 2) : false) || JSON.stringify(cfg) !== saved.config || token() !== saved.token;

function refreshDirty() {
  const dirty = isDirty();
  $('dirtyDot').className = `dot ${dirty ? 'dirty' : 'saved'}`;
  if ($('status').className !== 'bad') status(dirty ? 'Unsaved changes' : 'All changes saved');
  $('save').disabled = !dirty;
}

function show(next) {
  cfg = next;
  $('config').value = JSON.stringify(cfg, null, 2);
  renderBuilder($('form'), cfg, () => {
    $('config').value = JSON.stringify(cfg, null, 2);
    refreshDirty();
  });
  refreshDirty();
}

// Pulls a JSON-tab edit into `cfg`; false (with the parse error shown) if it doesn't parse.
function readJson() {
  if (tab !== 'json') return true;
  try {
    cfg = mergeConfig(JSON.parse($('config').value));
    return true;
  } catch (e) {
    status(`Not valid JSON: ${e.message}`, 'bad');
    return false;
  }
}

function setTab(next) {
  if (!readJson()) return;
  tab = next;
  if (tab === 'form') show(cfg);
  $('form').hidden = tab !== 'form';
  $('config').hidden = tab !== 'json';
  for (const b of document.querySelectorAll('#viewTabs button')) b.classList.toggle('on', b.dataset.tab === tab);
}

// Where these settings are kept besides this page: shared with the Mac app
// (or, in the app, with the extension) through one config.json, or not.
function showSharing(s) {
  const el = $('sharing');
  el.hidden = !s;
  if (!s) return;
  const where = s.file ? [' · ', h('code', {}, s.file.replace(/^\/Users\/[^/]+/, '~'))] : [];
  if (s.mode === 'app') el.replaceChildren(h('span', { class: 'dot pass' }), 'Shared with the PR Radar Chrome extension', ...where);
  else if (s.state === 'connected') el.replaceChildren(h('span', { class: 'dot pass' }), 'Shared with the PR Radar Mac app', ...where);
  else el.replaceChildren(h('span', { class: 'dot neutral' }), "Kept in this browser only. Open the PR Radar Mac app once to share these settings with it.");
  el.title = s.error || '';
}

async function load() {
  // In the extension this first takes any newer settings from the Mac app.
  await chrome.runtime.sendMessage({ type: 'syncShared' }).catch(() => {});
  const { config, token: stored, sharedStatus } = await chrome.storage.local.get(['config', 'token', 'sharedStatus']);
  showSharing(sharedStatus);
  const merged = structuredClone(mergeConfig(config));
  saved = { config: JSON.stringify(merged), token: stored || '' };
  $('token').value = stored || '';
  show(merged);
  if (stored) listRepos(stored).then(fillRepos).catch(() => {});
  const first = Object.keys(cfg.repos)[0];
  if (stored && first) suggest(first);
}

function fillRepos(repos) {
  $('repo').replaceChildren(...repos.map((r) => new Option(r, r)));
  setKnownRepos(repos);
  if (tab === 'form') show(cfg);
}

// Labels and check names of the repo being edited, so its fields autocomplete.
async function suggest(repo) {
  $('suggestStatus').textContent = `Loading suggestions from ${repo}…`;
  const [labels, checks] = await Promise.allSettled([listLabels(token(), repo), checkNames(token(), repo)]);
  fillSuggestions((labels.value || []).map((l) => l.name), checks.value || []);
  $('suggestStatus').textContent = [
    labels.value ? `${labels.value.length} labels` : 'no labels',
    checks.value ? `${checks.value.length} check names` : 'no check names',
  ].join(' and ') + ` from ${repo} autocomplete below`;
  $('suggestStatus').title = [labels.reason?.message, checks.reason?.message].filter(Boolean).join('\n');
}
onRepoSelected(suggest);

for (const b of document.querySelectorAll('#viewTabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
$('config').addEventListener('input', refreshDirty);
$('token').addEventListener('input', refreshDirty);
$('reveal').addEventListener('click', () => {
  const hidden = $('token').type === 'password';
  $('token').type = hidden ? 'text' : 'password';
  $('reveal').textContent = hidden ? 'Hide' : 'Show';
});

$('save').addEventListener('click', async () => {
  if (!readJson()) return;
  const errors = validateConfig(cfg);
  if (errors.length) return status(errors.join('\n'), 'bad');
  // Asked before anything else is awaited: Chrome shows the prompt only
  // during the click. Already-allowed sites don't prompt again.
  const origins = (cfg.badgePages || []).map((p) => p.match);
  const allowed = !origins.length || !chrome.permissions?.request || (await chrome.permissions.request({ origins }).catch(() => false));
  // `saved` first: the storage change this causes must not read as an outside edit.
  saved = { config: JSON.stringify(cfg), token: token() };
  await chrome.storage.local.set({ config: cfg, token: token() });
  status(allowed ? 'Saved. The panel is refreshing.' : "Saved, but Chrome wasn't allowed to show the badge on your badge pages. Save again to be asked again.", allowed ? '' : 'bad');
  $('dirtyDot').className = 'dot saved';
  $('save').disabled = true;
});

$('reset').addEventListener('click', () => {
  show(structuredClone(DEFAULT_CONFIG));
  status('Defaults loaded. Save to apply them.');
});

// The other side (the Mac app, or the extension) saved: reload unless this
// page has edits of its own, which would be lost.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.sharedStatus) showSharing(changes.sharedStatus.newValue);
  if (!changes.config && !changes.token) return;
  const incoming = { config: changes.config ? JSON.stringify(mergeConfig(changes.config.newValue)) : saved.config, token: changes.token ? changes.token.newValue || '' : saved.token };
  if (incoming.config === saved.config && incoming.token === saved.token) return;
  if (isDirty()) return status('These settings were changed somewhere else. Saving here will replace that change.', 'bad');
  load();
});

// ─── Notifications ──────────────────────────────────────────────────────
function showNotifyLog(log = []) {
  $('notifyLogBox').querySelector('summary').textContent = `Recent notifications (${log.length})`;
  $('notifyLog').replaceChildren(
    ...(log.length
      ? log.map((n) =>
          h('li', {}, h('span', { class: 'when', title: n.at }, new Date(n.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })), h('span', { class: 'what' }, h('strong', {}, n.title), h('span', {}, n.message))),
        )
      : [h('li', {}, h('span', { class: 'when' }, ''), h('span', { class: 'what' }, h('span', {}, 'None sent yet. PR Radar only notifies when something changes between two refreshes.')))]),
  );
}

async function showNotifyStatus() {
  const r = await chrome.runtime.sendMessage({ type: 'notificationStatus' }).catch(() => null);
  const denied = r?.permission === 'denied';
  $('notifyStatus').replaceChildren(
    h('span', { class: `dot ${denied ? 'fail' : 'pass'}` }),
    denied ? 'Notifications are blocked for PR Radar in Chrome (chrome://settings/content/notifications).' : 'PR Radar is allowed to notify. Your system decides whether they show.',
  );
}

$('testNotify').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'testNotification' }).catch(() => {});
  $('testNotify').textContent = 'Sent: did it appear?';
  $('notifyHelp').hidden = false;
  setTimeout(() => ($('testNotify').textContent = 'Send a test notification'), 6000);
});
chrome.storage.onChanged.addListener((c) => c.notificationLog && showNotifyLog(c.notificationLog.newValue));
chrome.storage.local.get('notificationLog').then(({ notificationLog }) => showNotifyLog(notificationLog));
showNotifyStatus();

$('export').addEventListener('click', () => {
  const withToken = token() && confirm('Include your GitHub token in the file? Anyone with the file could use it.\n\nOK includes it, Cancel leaves it out.');
  const data = { prRadar: 1, exportedAt: new Date().toISOString(), config: cfg, ...(withToken ? { token: token() } : {}) };
  const a = h('a', { href: URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' })), download: 'pr-radar-settings.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('import').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = data.config || data;
    const errors = validateConfig(mergeConfig(incoming));
    if (errors.length) return status(`That file isn't PR Radar settings:\n${errors.join('\n')}`, 'bad');
    if (tab === 'json') setTab('form');
    show(structuredClone(mergeConfig(incoming)));
    if (data.token) $('token').value = data.token;
    refreshDirty();
    status(`Loaded ${file.name}${data.token ? ' (with a token)' : ''}. Review it, then Save.`);
  } catch (e) {
    status(`Could not read ${file.name}: ${e.message}`, 'bad');
  }
});

$('test').addEventListener('click', async () => {
  const info = $('tokenInfo');
  info.hidden = false;
  info.className = 'token-info';
  info.textContent = 'Checking…';
  $('access').hidden = true;
  try {
    const me = await whoami(token());
    const repos = await listRepos(token());
    const byOwner = Object.entries(Object.groupBy(repos, (r) => r.split('/')[0]));
    info.textContent = [
      `Signed in as ${me.login}`,
      `${me.kind} token`,
      me.scopes && `scopes: ${me.scopes}`,
      me.expires && `expires ${me.expires}`,
      `sees ${repos.length} repos (${byOwner.map(([o, rs]) => `${o}: ${rs.length}`).join(', ') || 'none'})`,
    ]
      .filter(Boolean)
      .join(' · ');
    $('repoList').querySelector('summary').textContent = `Show all ${repos.length} repos`;
    $('repoList').querySelector('ul').replaceChildren(...repos.map((r) => h('li', {}, r)));
    fillRepos(repos);
    $('probes').replaceChildren();
    $('access').hidden = !repos.length;
    if (!repos.length) info.textContent += '. If this is a fine-grained token for an org, it may be waiting for the org to approve it.';
  } catch (e) {
    info.className = 'token-info bad';
    info.textContent = e.message;
  }
});

$('check').addEventListener('click', async () => {
  $('probes').replaceChildren(h('div', { class: 'probe' }, '', h('span', { class: 'muted' }, 'Checking…')));
  const results = await diagnose(token(), $('repo').value);
  $('probes').replaceChildren(
    ...results.map((r) =>
      h(
        'div',
        { class: `probe${r.ok ? '' : ' bad'}${r.info ? ' info' : ''}` },
        h('span', { class: `dot ${r.info ? 'neutral' : r.ok ? 'pass' : 'fail'}` }),
        h('span', { class: 'name' }, r.name),
        h('span', { class: 'detail' }, r.ok || !r.need ? r.detail : `${r.detail} → needs ${r.need}`),
      ),
    ),
  );
});

load();
