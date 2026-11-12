// The slice of the chrome.* extension API that background.js and the panel
// use, built on Electron, so the extension's own code runs unchanged in the
// menu bar app. Storage lives in the main process; renderers reach it over IPC
// (preload.cjs).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BrowserWindow, Notification, app, powerMonitor, safeStorage, shell } from 'electron';

const { create: createShared } = createRequire(import.meta.url)('./shared-store.cjs');

// ─── storage ─────────────────────────────────────────────────────────────
// chrome.storage.local, persisted to one file in the app's data folder,
// encrypted with the OS keychain (safeStorage) when that is available. The
// two keys the extension shares, `config` and `token`, live in the shared
// store instead (shared-store.cjs: config.json plus the keychain).
const FILE = join(app.getPath('userData'), 'storage.bin');
const listeners = { storage: [] };

// safeStorage only works once the app is ready (macOS refuses earlier), so
// the file is read in initStorage, which main.js awaits on `ready`; storage
// calls made before then wait for it.
let canEncrypt = false;
let markReady;
const ready = new Promise((r) => (markReady = r));

async function readStore() {
  if (!existsSync(FILE)) return {};
  try {
    const raw = readFileSync(FILE);
    if (raw.subarray(0, 5).toString() === 'json:') return JSON.parse(raw.subarray(5).toString());
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(raw);
    const data = JSON.parse(result);
    if (shouldReEncrypt) writeStore(data);
    return data;
  } catch (e) {
    // Never write over a file that couldn't be read: set it aside, so a
    // passing keychain problem doesn't destroy anything.
    const aside = `${FILE}.unreadable-${Date.now()}`;
    renameSync(FILE, aside);
    console.error(`PR Radar: could not read ${FILE}; moved it to ${aside} and started fresh.`, e);
    return {};
  }
}

// Debounced, and one write at a time: an encrypt that finishes late must not
// replace a newer write.
let writeTimer = null;
let writing = Promise.resolve();
function writeStore(data) {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const json = JSON.stringify(data);
    writing = writing
      .then(async () => writeFileSync(FILE, canEncrypt ? await safeStorage.encryptStringAsync(json) : Buffer.from(`json:${json}`)))
      .catch((e) => console.error('PR Radar: could not save state', e));
  }, 200);
}

function emit(changes, name) {
  for (const fn of listeners.storage) fn(changes, name);
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('storage-changed', changes, name);
}

export const shared = createShared(app.getPath('userData'));
const SHARED_KEYS = ['config', 'token'];
// What the shared store held when last read or written, so a change to
// config.json can be told apart from the app's own write.
const sharedSeen = { config: shared.read()?.config ?? null, token: shared.getToken(), tokenUpdatedAt: shared.read()?.tokenUpdatedAt || 0 };

function makeArea(name, data, persist) {
  const isShared = (k) => persist && SHARED_KEYS.includes(k);
  const value = (k) => (isShared(k) ? (k === 'config' ? sharedSeen.config ?? undefined : sharedSeen.token || undefined) : data[k]);
  return {
    async get(keys) {
      await ready;
      const all = [...Object.keys(data), ...(persist ? SHARED_KEYS : [])];
      const list = keys == null ? all : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return structuredClone(Object.fromEntries(list.map((k) => [k, value(k)]).filter(([, v]) => v !== undefined)));
    },
    async set(items) {
      await ready;
      const changes = {};
      const toShare = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: value(k), newValue: v };
        if (isShared(k)) toShare[k] = v;
        else data[k] = structuredClone(v);
      }
      if (Object.keys(toShare).length) {
        const saved = shared.set(toShare, 'app');
        if ('config' in toShare) sharedSeen.config = toShare.config;
        if ('token' in toShare) Object.assign(sharedSeen, { token: toShare.token || '', tokenUpdatedAt: saved.tokenUpdatedAt });
      }
      if (persist) writeStore(data);
      emit(changes, name);
    },
  };
}

const local = {};

export async function initStorage() {
  canEncrypt = await safeStorage.isAsyncEncryptionAvailable();
  Object.assign(local, await readStore());
  // Settings saved before sharing existed move into the shared store once.
  if (!shared.read() && (local.config || local.token)) {
    shared.set({ config: local.config ?? null, token: local.token || '' }, 'app');
    Object.assign(sharedSeen, { config: local.config ?? null, token: local.token || '' });
  }
  if ('config' in local || 'token' in local) {
    delete local.config;
    delete local.token;
    writeStore(local);
  }
  markReady();
}

export const storage = { local: makeArea('local', local, true), session: makeArea('session', {}, false) };

// The extension writes config.json through host.cjs; pick that up and tell
// the background code and the windows, as Chrome would for a storage change.
// The file is replaced by a rename, so the folder is watched, not the file.
let watchTimer = null;
mkdirSync(shared.dir, { recursive: true });
watch(shared.dir, (_event, name) => {
  if (name !== 'config.json') return;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    const s = shared.read();
    if (!s) return;
    const changes = {};
    if (JSON.stringify(s.config ?? null) !== JSON.stringify(sharedSeen.config)) {
      changes.config = { oldValue: sharedSeen.config ?? undefined, newValue: s.config ?? undefined };
      sharedSeen.config = s.config ?? null;
    }
    if ((s.tokenUpdatedAt || 0) !== sharedSeen.tokenUpdatedAt) {
      const token = shared.getToken();
      if (token !== sharedSeen.token) changes.token = { oldValue: sharedSeen.token || undefined, newValue: token || undefined };
      Object.assign(sharedSeen, { token, tokenUpdatedAt: s.tokenUpdatedAt || 0 });
    }
    if (Object.keys(changes).length) emit(changes, 'local');
  }, 150);
});

// ─── Chrome tabs, over AppleScript (macOS) ───────────────────────────────
// Lets "switch to the tab already showing this PR" work from outside the
// browser. It never launches Chrome, and if macOS's automation prompt is
// declined every lookup comes back empty, so links just open normally.
function osa(lines) {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => execFile('osascript', lines.flatMap((l) => ['-e', l]), { timeout: 4000 }, (err, out) => resolve(err ? null : out.trim())));
}

const CHROME_TABS = [
  'set out to ""',
  'if application "Google Chrome" is running then',
  'tell application "Google Chrome"',
  'repeat with w in windows',
  'set i to 0',
  'repeat with t in tabs of w',
  'set i to i + 1',
  'set out to out & (id of w) & tab & i & tab & (URL of t) & linefeed',
  'end repeat',
  'end repeat',
  'end tell',
  'end if',
  'return out',
];
const ACTIVE_TAB = ['if application "Google Chrome" is running then', 'tell application "Google Chrome" to return URL of active tab of front window', 'end if', 'return ""'];

async function chromeTabs(query = {}) {
  if (query.active) {
    const url = await osa(ACTIVE_TAB);
    return url ? [{ id: 'active', windowId: 0, url }] : [];
  }
  const out = await osa(CHROME_TABS);
  const tabs = (out || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [windowId, index, url] = line.split('\t');
      return { id: `${windowId}:${index}`, windowId: Number(windowId), url };
    });
  const prefix = query.url ? query.url.replace(/\*$/, '') : '';
  return prefix ? tabs.filter((t) => t.url.startsWith(prefix)) : tabs;
}

async function focusChromeTab(id) {
  const [w, i] = String(id).split(':').map(Number);
  if (!w || !i) return;
  await osa(['tell application "Google Chrome"', `set active tab index of (first window whose id is ${w}) to ${i}`, `set index of (first window whose id is ${w}) to 1`, 'activate', 'end tell']);
}

// ─── the chrome object ───────────────────────────────────────────────────
const hooks = { startup: [], message: [], alarm: [], idle: [], notificationClick: [] };
const alarms = new Map();
const notifications = new Map();
let badgeHandler = () => {};
let cardHandler = { show: () => {}, clear: () => {} };

// What the app shell needs from this module: start-up, message dispatch,
// and where the badge text goes.
export const host = {
  onBadge: (fn) => (badgeHandler = fn),
  // Where notification cards go, and how a click on one comes back.
  onCards: (handler) => (cardHandler = handler),
  notificationClicked: (id) => hooks.notificationClick.forEach((fn) => fn(id)),
  startup: () => hooks.startup.forEach((fn) => fn()),
  // Runs a chrome.runtime message through background.js's listeners and
  // resolves with the reply, as Chrome does.
  message: (msg) =>
    new Promise((resolve) => {
      let async = false;
      for (const fn of hooks.message) if (fn(msg, {}, resolve) === true) async = true;
      if (!async) resolve(undefined);
    }),
  tabsQuery: chromeTabs,
};

let lastIdle = 'active';
setInterval(async () => {
  const now = await chrome.idle.queryState(600);
  if (now !== lastIdle) hooks.idle.forEach((fn) => fn(now));
  lastIdle = now;
}, 60_000).unref?.();
powerMonitor.on('unlock-screen', () => hooks.idle.forEach((fn) => fn('active')));
powerMonitor.on('resume', () => hooks.idle.forEach((fn) => fn('active')));

const ICON = join(import.meta.dirname, 'ext', 'icon.png');

// macOS delivers an Electron notification only from an app signed with an
// Apple developer certificate; from an unsigned or ad-hoc signed one (npm
// start, or a build without one) it drops them without an error. Those builds
// show their own notification cards instead (main.js, toast.html).
// PR_RADAR_TOASTS=1 forces the cards anywhere, for tests.
const useCards =
  process.env.PR_RADAR_TOASTS === '1'
    ? Promise.resolve(true)
    : process.platform !== 'darwin'
      ? Promise.resolve(false)
      : new Promise((resolve) => execFile('codesign', ['-dv', '--verbose=2', process.execPath], (err, out, info) => resolve(err || !/Authority=/.test(info) || /Signature=adhoc/.test(info))));

export const chrome = {
  storage: { ...storage, onChanged: { addListener: (fn) => listeners.storage.push(fn) } },
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: (fn) => hooks.startup.push(fn) },
    onMessage: { addListener: (fn) => hooks.message.push(fn) },
  },
  alarms: {
    create(name, { delayInMinutes, periodInMinutes }) {
      clearTimeout(alarms.get(name));
      const fire = () => {
        hooks.alarm.forEach((fn) => fn({ name }));
        if (periodInMinutes) alarms.set(name, setTimeout(fire, periodInMinutes * 60_000));
      };
      alarms.set(name, setTimeout(fire, (delayInMinutes ?? periodInMinutes) * 60_000));
    },
    async clear(name) {
      clearTimeout(alarms.get(name));
      return alarms.delete(name);
    },
    onAlarm: { addListener: (fn) => hooks.alarm.push(fn) },
  },
  idle: {
    setDetectionInterval: () => {},
    // Chrome's vocabulary: active | idle | locked. "unknown" counts as active
    // so a platform without idle detection still polls.
    async queryState(seconds) {
      const s = powerMonitor.getSystemIdleState(seconds);
      return s === 'idle' || s === 'locked' ? s : 'active';
    },
    onStateChanged: { addListener: (fn) => hooks.idle.push(fn) },
  },
  notifications: {
    async create(id, { title, message }) {
      if (await useCards) return cardHandler.show({ id, title, message });
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body: message, icon: ICON });
      n.on('click', () => hooks.notificationClick.forEach((fn) => fn(id)));
      n.on('failed', () => cardHandler.show({ id, title, message }));
      notifications.set(id, n);
      n.show();
    },
    getPermissionLevel: (callback) => callback('granted'),
    clear(id) {
      notifications.get(id)?.close();
      notifications.delete(id);
      cardHandler.clear(id);
    },
    onClicked: { addListener: (fn) => hooks.notificationClick.push(fn) },
  },
  action: {
    setBadgeText: ({ text }) => badgeHandler(text),
    setBadgeBackgroundColor: () => {},
  },
  sidePanel: { setPanelBehavior: () => {} },
  tabs: {
    query: chromeTabs,
    create: ({ url }) => shell.openExternal(url),
    update: (id) => focusChromeTab(id),
  },
  windows: { update: async () => {} },
  // The artifact link needs the browser's GitHub login, so the browser
  // downloads it.
  downloads: { download: ({ url }) => shell.openExternal(url) },
};
