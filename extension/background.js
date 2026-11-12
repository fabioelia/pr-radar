import { pullShared, shareLocalChanges } from './shared.js';
import { DRAFT_MUTATIONS, actionsContexts, emptyActionsCache, gh, graphql, prStates, prTexts, pruneActionsCache, restRate } from './github.js';
import { QUERY, WATCH_QUERY, applyRunCommits, attention, checksHidden, watchReason, watchedKeys, rowSessions, sessionId, sessionLinksIn, tabFor, touchesChecks, diff, mapLimit, mergeConfig, normalize, profileFor, rowsForUrl, scopedQuery, settleEnded, summarizeErrors, badgeLinks } from './lib.js';

async function settings() {
  const { config, token } = await chrome.storage.local.get(['config', 'token']);
  return { config: mergeConfig(config), token };
}


// Returns whether anything is still running, which sets the next interval.
// The commit each report's Actions run was for (the Playwright comment names
// only its run). A run's commit never changes, so each is asked once and
// kept, the newest 500.
async function resolveRunCommits(token, rows, config) {
  const want = rows.flatMap((r) => Object.values(r.madeFor || {}).filter((m) => m.run && !m.sha).map((m) => [m.run, r.repo]));
  const { runCommits = {} } = want.length ? await chrome.storage.local.get('runCommits') : {};
  const missing = [...new Map(want.filter(([run]) => !runCommits[run]))];
  await mapLimit(missing, 4, async ([run, repo]) => {
    try {
      runCommits[run] = (await gh(token, `/repos/${repo}/actions/runs/${run}`)).head_sha;
    } catch {
      // unknown commit: the report just isn't marked stale this time
    }
  });
  if (missing.length) {
    const keys = Object.keys(runCommits);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete runCommits[k];
    await chrome.storage.local.set({ runCommits });
  }
  for (const r of rows) applyRunCommits(r, runCommits, config);
}

// Card rows for fetched PRs: checks from the GraphQL response, or from the
// Actions API where the token can't see check runs, then each report's
// commit. Shared by the full poll and the watch tick.
async function buildRows(pending, { config, token, actionsCache, prevRows = [] }) {
  const viaActions = (p) => config.checksSource === 'actions' || (config.checksSource !== 'checks' && p.hidden);
  const before = Object.fromEntries(prevRows.map((r) => [r.key, r]));
  const actionFailures = [];
  const rows = await mapLimit(pending, 4, async (p) => {
    if (!viaActions(p)) return { ...normalize(p.node, config), checksFrom: 'checks' };
    try {
      const contexts = await actionsContexts(token, p.node.repository.nameWithOwner, p.node.headRefOid, actionsCache, p.node.updatedAt);
      return { ...normalize(p.node, config, contexts), checksFrom: 'actions' };
    } catch (e) {
      actionFailures.push(e.message);
      // Keep the last known checks rather than blanking the chips; the
      // next poll tries again.
      const row = { ...normalize(p.node, config, []), checksFrom: 'actions' };
      const old = before[row.key];
      if (old?.sha === row.sha) {
        row.checks = old.checks;
        row.attention = attention(row, config);
        row.stale = true;
      }
      return row;
    }
  });
  await resolveRunCommits(token, rows, config);
  return { rows, actionFailures };
}

// Each notification gets its own ID: Chrome silently replaces one that
// reuses the ID of a notification still in the OS notification center, so
// keying by PR made every later notification for that PR invisible. Sent
// ones are logged (newest 30) for the settings page, which tells "PR Radar
// sent nothing" apart from "the OS hid it".
const LOG_SIZE = 30;
async function notify(events) {
  if (!events.length) return;
  const { notificationLog = [] } = await chrome.storage.local.get('notificationLog');
  const { notificationUrls = {} } = await chrome.storage.session.get('notificationUrls');
  for (const e of events) {
    const id = `${e.key || 'pr-radar'}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    notificationUrls[id] = e.url;
    chrome.notifications.create(id, { type: 'basic', iconUrl: 'icon.png', title: e.title, message: e.message, priority: 2 });
    notificationLog.unshift({ at: new Date().toISOString(), title: e.title, message: e.message, url: e.url });
  }
  const ids = Object.keys(notificationUrls);
  for (const k of ids.slice(0, Math.max(0, ids.length - 100))) delete notificationUrls[k];
  await chrome.storage.session.set({ notificationUrls });
  await chrome.storage.local.set({ notificationLog: notificationLog.slice(0, LOG_SIZE) });
}

function showCount(rows) {
  const needs = rows.filter((r) => r.attention.length).length;
  chrome.action.setBadgeText({ text: needs ? String(needs) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#d73a4a' });
}

async function poll() {
  // The Mac app may have changed the shared settings since the last poll.
  await pullShared();
  const { config, token } = await settings();
  if (!token) {
    await chrome.storage.local.set({ snapshot: { rows: [], sections: [], error: 'Add a GitHub token in Settings.', fetchedAt: null } });
    chrome.action.setBadgeText({ text: '!' });
    return;
  }
  const { snapshot: prev } = await chrome.storage.local.get('snapshot');
  if (!Object.keys(config.repos).length) {
    await chrome.storage.local.set({ snapshot: { rows: [], sections: [], error: 'No repos set up yet. Add one in Settings: only repos you set up are tracked.', fetchedAt: null } });
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const { actionsCache = emptyActionsCache() } = await chrome.storage.session.get('actionsCache');
  try {
    const seen = new Set();
    const sections = [];
    let rate = null;
    const errors = [];
    const pending = [];
    for (const { title, q } of config.queries) {
      const { data, errors: partial = [] } = await graphql(token, QUERY, { q: scopedQuery(q, config), n: 50 });
      rate = data.rateLimit;
      const blocked = new Set(partial.filter(touchesChecks).map((e) => e.path[2]));
      // The Actions fallback replaces exactly the fields these errors are about.
      errors.push(...(config.checksSource === 'checks' ? partial : partial.filter((e) => !touchesChecks(e))));
      const keys = [];
      data.search.nodes.forEach((node, i) => {
        // The search is limited to set-up repos; this also drops a PR that
        // matched while its repo was being removed from settings.
        if (!node?.number || !config.repos[node.repository.nameWithOwner]) return;
        const key = `${node.repository.nameWithOwner}#${node.number}`;
        if (seen.has(key)) return;
        seen.add(key);
        pending.push({ node, hidden: blocked.has(i) || checksHidden(node) });
        keys.push(key);
      });
      sections.push({ title, keys });
    }
    const lists = await chrome.storage.local.get(WATCH_LISTS);
    const { rows, actionFailures } = await buildRows(pending, { config, token, actionsCache, prevRows: prev?.rows });
    // Why each PR that left the list left: merged, closed, or no longer
    // matching a search. Merged and closed ones stay for the badges.
    const left = (prev?.rows || []).filter((r) => !seen.has(r.key));
    const byId = left.length ? await prStates(token, left.map((r) => r.id)).catch(() => ({})) : {};
    const states = Object.fromEntries(left.filter((r) => byId[r.id]).map((r) => [r.key, byId[r.id]]));
    const { ended: prevEnded } = await chrome.storage.local.get('ended');
    await chrome.storage.local.set({ ended: settleEnded(prevEnded, left, seen, states) });
    await notify(diff(prev?.rows, rows, config, watchedKeys({ sections }, lists), states));
    await pruneWatchLists(lists, rows);
    showCount(rows);
    const warning =
      [
        errors.length ? summarizeErrors(errors) : '',
        actionFailures.length
          ? `GitHub's Actions API failed for ${actionFailures.length} PR${actionFailures.length === 1 ? '' : 's'} after retries (${actionFailures[0]}). Their last known checks are shown; the next refresh tries again.`
          : '',
      ]
        .filter(Boolean)
        .join('\n') || null;
    rate = { graphql: rate, rest: restRate() };
    const busy = rows.some((r) => r.stale || r.checks.some((c) => c.state === 'pending'));
    await chrome.storage.session.set({ actionsCache: pruneActionsCache(actionsCache) });
    await chrome.storage.local.set({ snapshot: { rows, sections, rate, error: null, warning, busy, fetchedAt: new Date().toISOString() } });
    return busy;
  } catch (err) {
    // Keep the last good rows on screen; only surface the error.
    await chrome.storage.local.set({ snapshot: { ...(prev || { rows: [], sections: [] }), error: String(err.message || err) } });
    chrome.action.setBadgeText({ text: '!' });
    return true;
  }
}

// One poll at a time, so two never write the Actions cache over each other.
// A refresh asked for mid-poll (a saved setting, a click) runs one more poll
// afterwards: the running one may have read the settings before the change.
let inFlight = null;
let again = false;
// The full poll and the watch tick both rewrite the snapshot, so they take
// turns.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

function refresh() {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = exclusive(async () => {
    let busy;
    do {
      again = false;
      busy = await poll();
    } while (again);
    await schedule(busy);
    await scheduleWatch();
  }).finally(() => (inFlight = null));
  return inFlight;
}

// ─── Watching ─────────────────────────────────────────────────────────────
// Between full polls, the PRs being watched (watchReason: a running check
// or report that notifies, or a bell) are checked on their own every
// watchSeconds, all in one request, so a result lands within seconds
// rather than at the next poll. Paused only while the screen is locked.
const WATCH_LISTS = ['watched', 'watchedGroups', 'unwatched'];

// Bells of PRs that have left every list are dropped, so the lists don't grow.
async function pruneWatchLists({ watched = [], unwatched = [] }, rows) {
  const live = new Set(rows.map((r) => r.key));
  const next = { watched: watched.filter((k) => live.has(k)), unwatched: unwatched.filter((k) => live.has(k)) };
  if (next.watched.length !== watched.length || next.unwatched.length !== unwatched.length) await chrome.storage.local.set(next);
}

async function watchTargets() {
  const [{ config }, stored] = await Promise.all([settings(), chrome.storage.local.get(['snapshot', ...WATCH_LISTS])]);
  const { snapshot } = stored;
  const manual = watchedKeys(snapshot, stored);
  return { config, snapshot, manual, targets: (snapshot?.rows || []).filter((r) => watchReason(r, config, manual)) };
}

async function scheduleWatch() {
  const { config, targets } = await watchTargets();
  const period = Math.max(5, Number(config.watchSeconds) || 30) / 60;
  const current = await chrome.alarms.get?.('watch');
  if (!targets.length) return chrome.alarms.clear('watch');
  if (current?.periodInMinutes !== period) chrome.alarms.create('watch', { delayInMinutes: period, periodInMinutes: period });
}

// PRs per watch request. All of them in one request made GitHub time out
// (504) once a group bell watched many PRs: each brings its checks and its
// latest comments, which hold whole QA reports.
const WATCH_BATCH = 5;

// After a failed watch check, skip ticks for a while, doubling each time
// (up to 5 minutes), and log once per run of failures rather than per tick.
const backoff = { failures: 0, until: 0 };

async function watchTick() {
  if (Date.now() < backoff.until) return;
  if ((await chrome.idle.queryState(60)) === 'locked') return;
  const { config, snapshot, manual, targets } = await watchTargets();
  const { token } = await settings();
  if (!token || !targets.length) return scheduleWatch();
  const batches = [];
  for (let i = 0; i < targets.length; i += WATCH_BATCH) batches.push(targets.slice(i, i + WATCH_BATCH));
  const failed = [];
  const answers = await mapLimit(batches, 2, async (batch) => {
    try {
      return await graphql(token, WATCH_QUERY, { ids: batch.map((r) => r.id) });
    } catch (e) {
      failed.push(e);
      return null;
    }
  });
  if (failed.length) {
    backoff.failures++;
    const wait = Math.min(300, (Number(config.watchSeconds) || 30) * 2 ** backoff.failures);
    backoff.until = Date.now() + wait * 1000;
    if (backoff.failures === 1) console.warn(`PR Radar: a watch check failed (${failed[0].message}); trying again in ${wait}s, backing off while it keeps failing.`);
    if (failed.length === batches.length) return;
  } else {
    if (backoff.failures > 1) console.info(`PR Radar: watch checks are working again after ${backoff.failures} failures.`);
    Object.assign(backoff, { failures: 0, until: 0 });
  }
  const open = [];
  let closed = false;
  for (const answer of answers) {
    if (!answer?.data) continue;
    const blocked = new Set((answer.errors || []).filter(touchesChecks).map((e) => e.path?.[1]));
    answer.data.nodes.forEach((node, i) => {
      if (node?.state === 'OPEN') open.push({ node, hidden: blocked.has(i) || checksHidden(node) });
      else closed = true;
    });
  }
  const { actionsCache = emptyActionsCache() } = await chrome.storage.session.get('actionsCache');
  const { rows } = await buildRows(open, { config, token, actionsCache, prevRows: snapshot.rows });
  const fresh = new Map(rows.map((r) => [r.key, r]));
  // Only the PRs that came back are compared: one that closed is left to
  // the full poll below, which reports it once.
  await notify(diff(targets.filter((r) => fresh.has(r.key)), rows, config, manual));
  const merged = snapshot.rows.map((r) => fresh.get(r.key) || r);
  showCount(merged);
  const busy = merged.some((r) => r.stale || r.checks.some((c) => c.state === 'pending'));
  await chrome.storage.session.set({ actionsCache: pruneActionsCache(actionsCache) });
  await chrome.storage.local.set({ snapshot: { ...snapshot, rows: merged, busy, watchedAt: new Date().toISOString() } });
  if (closed) refresh();
  else await scheduleWatch();
}

function onWatchAlarm() {
  // A full poll in progress covers the watched PRs too.
  if (inFlight) return;
  exclusive(watchTick).catch((e) => console.error('PR Radar: watch check failed', e));
  // ponytail: errors outside the GitHub calls (storage, a bug) still log per tick.
}

// While a check is running, poll every pollMinutes; once everything has
// settled, every quietPollMinutes.
async function schedule(busy = true) {
  const { config } = await settings();
  const minutes = busy ? config.pollMinutes : config.quietPollMinutes;
  await chrome.alarms.clear('poll');
  chrome.alarms.create('poll', { delayInMinutes: Math.max(0.5, Number(minutes) || 2) });
}

// No polling while the computer is locked or nobody has touched it for
// IDLE_SECONDS; the first poll after they're back runs at once.
const IDLE_SECONDS = 600;
chrome.idle.setDetectionInterval(IDLE_SECONDS);
chrome.idle.onStateChanged.addListener((state) => state === 'active' && refresh());
async function onAlarm() {
  if ((await chrome.idle.queryState(IDLE_SECONDS)) !== 'active') return schedule(false);
  return refresh();
}

async function act({ action, row, jobUrl }) {
  const { token } = await settings();
  const [owner, repo] = row.repo.split('/');
  const issue = `/repos/${owner}/${repo}/issues/${row.number}`;
  if (action.type === 'setLabels') {
    if (action.add?.length) await gh(token, `${issue}/labels`, { method: 'POST', body: { labels: action.add } });
    for (const name of action.remove || []) await gh(token, `${issue}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' });
  } else if (DRAFT_MUTATIONS[action.type]) {
    const { errors } = await graphql(token, DRAFT_MUTATIONS[action.type], { id: row.id });
    if (errors?.length) throw new Error(summarizeErrors(errors));
  } else if (action.type === 'close') {
    await gh(token, `/repos/${owner}/${repo}/pulls/${row.number}`, { method: 'PATCH', body: { state: 'closed' } });
  } else if (action.type === 'rerunJob') {
    const job = jobUrl.match(/\/job\/(\d+)/)?.[1];
    if (!job) throw new Error('Not an Actions job, so it cannot be re-run from here.');
    await gh(token, `/repos/${owner}/${repo}/actions/jobs/${job}/rerun`, { method: 'POST' });
  } else throw new Error(`Unknown action ${action.type}`);
}

// Downloads through github.com's own artifact link rather than the API's
// signed-URL redirect: the browser's GitHub login authorizes it, so the token
// only needs Actions read to list the run's artifacts.
async function download({ row, extractor }) {
  const { config, token } = await settings();
  const ex = profileFor(config, row.repo).extractors.find((e) => e.name === extractor);
  const run = row.artifactRuns?.[extractor];
  if (!ex?.artifacts || !run) throw new Error(`No Actions run linked from ${extractor}.`);
  const { artifacts } = await gh(token, `/repos/${row.repo}/actions/runs/${run}/artifacts?per_page=100`);
  const re = new RegExp(ex.artifacts);
  const hits = artifacts.filter((a) => re.test(a.name));
  const live = hits.filter((a) => !a.expired);
  if (!live.length) throw new Error(hits.length ? 'That artifact has expired.' : `Run ${run} has no artifact matching ${ex.artifacts}.`);
  for (const a of live) await chrome.downloads.download({ url: `https://github.com/${row.repo}/actions/runs/${run}/artifacts/${a.id}`, filename: `${a.name}.zip` });
  return live.length;
}


chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  reinjectBadge();
  refresh();
});
chrome.runtime.onStartup.addListener(() => refresh());
chrome.alarms.onAlarm.addListener((a) => (a.name === 'poll' ? onAlarm() : a.name === 'watch' && onWatchAlarm()));
// Switches to a tab already showing `url` (or a page under it) before
// opening a new one. Tab URLs are only visible for hosts in
// host_permissions, so a preview link always opens fresh.
async function openTab(url) {
  let tabs = [];
  try {
    // A session link looks at every claude.ai tab: the session may be open
    // at a URL that only shares its ID.
    tabs = await chrome.tabs.query({ url: sessionId(url) ? 'https://claude.ai/*' : `${url.split(/[?#]/)[0]}*` });
  } catch {
    // not a valid match pattern (an odd scheme or host): just open it
  }
  const hit = tabFor(tabs, url);
  if (!hit) return chrome.tabs.create({ url });
  await chrome.tabs.update(hit.id, { active: true });
  await chrome.windows.update(hit.windowId, { focused: true });
}

shareLocalChanges();
chrome.notifications.onClicked.addListener(async (id) => {
  const { notificationUrls = {} } = await chrome.storage.session.get('notificationUrls');
  const url = notificationUrls[id] || (id.startsWith('http') ? id : '');
  if (url) openTab(url);
  chrome.notifications.clear(id);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.config) syncBadgePages();
  if (changes.config || changes.token) refresh();
  else if (WATCH_LISTS.some((k) => changes[k])) scheduleWatch().then(onWatchAlarm);
});
// The PRs for a page, and, when there are none, why: the badge says so
// instead of staying hidden.
async function match(url) {
  const [{ snapshot, ended = {} }, { config, token }] = await Promise.all([chrome.storage.local.get(['snapshot', 'ended']), settings()]);
  // Open PRs first, then the merged or closed ones, newest first; each with
  // its Claude sessions, for pages that show both (a PR preview).
  // Merged and closed PRs carry no links: their preview is usually gone.
  const rows = rowsForUrl([...(snapshot?.rows || []), ...Object.values(ended)], url, config).map((r) => ({ ...r, sessions: rowSessions(r), links: r.ended ? [] : badgeLinks(r, config) }));
  const setup = !token ? 'no-token' : !Object.keys(config.repos).length ? 'no-repos' : snapshot?.error ? 'error' : !snapshot?.fetchedAt ? 'loading' : 'ok';
  return { rows, setup, error: snapshot?.error || '' };
}

// The Claude sessions a PR links, for the badge on its GitHub page: from the
// last poll when the panel tracks the PR, else asked of GitHub (any PR you
// open, in any repo), remembered for a few minutes.
const SESSIONS_TTL_MS = 5 * 60 * 1000;
const sessionCache = new Map();
async function sessionsFor(repo, number) {
  const [{ snapshot, ended = {} }, { config }] = await Promise.all([chrome.storage.local.get(['snapshot', 'ended']), settings()]);
  const same = (r) => r.repo.toLowerCase() === repo.toLowerCase() && r.number === number;
  const row = snapshot?.rows?.find(same);
  if (row) return { sessions: rowSessions(row), stale: Object.keys(row.staleReports || {}), state: 'OPEN', links: badgeLinks(row, config) };
  const done = Object.values(ended).find(same);
  if (done) return { sessions: rowSessions(done), stale: [], state: done.ended };
  const key = `${repo.toLowerCase()}#${number}`;
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < SESSIONS_TTL_MS) return { sessions: hit.sessions, stale: [], state: hit.state };
  const { token } = await settings();
  if (!token) return { sessions: [], stale: [] };
  const { texts, state } = await prTexts(token, repo, number).catch(() => ({ texts: [], state: '' }));
  const sessions = sessionLinksIn(texts);
  sessionCache.set(key, { at: Date.now(), sessions, state });
  return { sessions, stale: [], state };
}

// The badge on the config's badgePages: Chrome runs content.js there only
// once you allow the site (settings asks when you save), so only allowed
// patterns are registered. The Mac app has neither API and no badges.
const BADGE_SCRIPT = 'badge-pages';
async function allowedBadgePages() {
  if (!chrome.permissions?.contains) return [];
  const { config } = await settings();
  const pages = [];
  for (const { match } of config.badgePages || []) if (await chrome.permissions.contains({ origins: [match] }).catch(() => false)) pages.push(match);
  return pages;
}
async function syncBadgePages() {
  if (!chrome.scripting?.registerContentScripts) return;
  const pages = await allowedBadgePages();
  await chrome.scripting.unregisterContentScripts({ ids: [BADGE_SCRIPT] }).catch(() => {});
  if (pages.length) await chrome.scripting.registerContentScripts([{ id: BADGE_SCRIPT, matches: pages, js: ['content.js'], runAt: 'document_idle' }]).catch((e) => console.warn('PR Radar: badge pages', e));
}
syncBadgePages();
chrome.permissions?.onAdded?.addListener(() => syncBadgePages());
chrome.permissions?.onRemoved?.addListener(() => syncBadgePages());

// A reload or update of the extension cuts off the badge script in tabs
// that were already open, and Chrome doesn't put a new one in them; this
// does, and the new script removes the old one's badge.
async function reinjectBadge() {
  const pages = await allowedBadgePages();
  const tabs = await chrome.tabs.query({ url: [...chrome.runtime.getManifest().content_scripts[0].matches, ...pages] }).catch(() => []);
  for (const t of tabs) chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'match') {
    match(msg.url).then((m) => reply({ ok: true, ...m }));
    return true;
  }
  if (msg.type === 'sessionsFor') {
    sessionsFor(msg.repo, msg.number).then((r) => reply({ ok: true, ...r }), () => reply({ ok: true, sessions: [], stale: [] }));
    return true;
  }
  if (msg.type === 'testNotification') {
    notify([{ key: 'test', title: 'PR Radar test notification', message: 'If you can read this, notifications reach you. Click to open your PRs on GitHub.', url: 'https://github.com/pulls' }]).then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === 'notificationStatus') {
    // Whether Chrome lets this extension notify (the OS can still hide them).
    // Callback form: Chrome's promise form of this call never settles.
    if (!chrome.notifications.getPermissionLevel) reply({ ok: true, permission: 'granted' });
    else chrome.notifications.getPermissionLevel((permission) => reply({ ok: true, permission }));
    return true;
  }
  if (msg.type === 'openSettings') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (msg.type === 'syncShared') {
    pullShared().then(() => reply({ ok: true }));
    return true;
  }
  if (msg.type === 'open') {
    openTab(msg.url).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e.message || e) }));
    return true;
  }
  const run = msg.type === 'refresh' ? refresh() : msg.type === 'act' ? act(msg).then(() => refresh()) : msg.type === 'download' ? download(msg) : null;
  if (!run) return false;
  run.then(() => reply({ ok: true })).catch((e) => reply({ ok: false, error: String(e.message || e) }));
  return true;
});
