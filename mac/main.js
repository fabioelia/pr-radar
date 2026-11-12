// PR Radar in the menu bar: a tray icon showing how many PRs need you, and
// the extension's side panel as a popover under it. The extension's
// background.js runs here unchanged, on the chrome.* API from shim.js.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, nativeTheme, screen, shell } from 'electron';
import { chrome, host, initStorage, shared, storage } from './shim.js';

const DIR = import.meta.dirname;
const PANEL = { width: 420, height: 680 };

// Tests point the app at a mock GitHub; never set in normal use.
if (process.env.PR_RADAR_API) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(typeof url === 'string' ? url.replace('https://api.github.com', process.env.PR_RADAR_API) : url, init);
}

if (!app.requestSingleInstanceLock()) app.quit();

let tray = null;
let panel = null;
let settings = null;
let badge = '';

const pageWindow = (opts) =>
  new BrowserWindow({
    ...opts,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1015' : '#f5f6f8',
    webPreferences: { preload: join(DIR, 'preload.cjs'), contextIsolation: false, sandbox: true, nodeIntegration: false },
  });

// Every link leaves the app for the browser; these windows only ever show
// the bundled pages.
function keepLinksOut(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    e.preventDefault();
    shell.openExternal(url);
  });
}

function getPanel() {
  if (panel && !panel.isDestroyed()) return panel;
  panel = pageWindow({ ...PANEL, show: false, frame: false, resizable: true, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true });
  panel.loadFile(join(DIR, 'ext', 'sidepanel.html'));
  panel.on('blur', () => !panel.webContents.isDevToolsOpened() && panel.hide());
  keepLinksOut(panel);
  return panel;
}

// Centered under the menu bar icon, kept on screen. Linux and some setups
// report no tray position; the top-right corner stands in.
function placePanel(win) {
  const b = tray.getBounds();
  const { workArea } = screen.getDisplayMatching(b.width ? b : screen.getPrimaryDisplay().bounds);
  const [w] = win.getSize();
  const x = b.width ? b.x + b.width / 2 - w / 2 : workArea.x + workArea.width - w;
  win.setPosition(Math.round(Math.min(Math.max(x, workArea.x + 8), workArea.x + workArea.width - w - 8)), Math.round(b.height ? b.y + b.height + 4 : workArea.y + 8));
}

function togglePanel() {
  const win = getPanel();
  if (win.isVisible()) return win.hide();
  placePanel(win);
  win.show();
  win.focus();
  // The panel highlights the PR open in the front Chrome tab; it may have
  // changed while the panel was hidden.
  win.webContents.send('tabs-activated');
}

function openSettings() {
  if (settings && !settings.isDestroyed()) return settings.show(), settings.focus();
  settings = pageWindow({ width: 1000, height: 860, title: 'PR Radar settings' });
  settings.loadFile(join(DIR, 'ext', 'options.html'));
  keepLinksOut(settings);
  panel?.hide();
  app.focus({ steal: true });
}

// Notification cards (toast.html), for builds macOS won't deliver
// notifications for: one click-through-free window in the top-right corner of
// the screen with the pointer, sized to its cards, shown without taking focus.
const CARD_WIDTH = 380;
let cards = null;
let cardsReady = null;
function getCards() {
  if (cards && !cards.isDestroyed()) return cards;
  cards = new BrowserWindow({
    width: CARD_WIDTH,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: { preload: join(DIR, 'toast-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  cards.setAlwaysOnTop(true, 'floating');
  cards.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  keepLinksOut(cards);
  cardsReady = new Promise((resolve) => cards.webContents.once('did-finish-load', resolve));
  cards.loadFile(join(DIR, 'toast.html'));
  return cards;
}
host.onCards({
  async show(card) {
    const win = getCards();
    await cardsReady;
    win.webContents.send('card:show', card);
  },
  clear: (id) => cards && !cards.isDestroyed() && cards.webContents.send('card:clear', id),
});
ipcMain.on('card:click', (_e, id) => host.notificationClicked(id));
ipcMain.on('card:size', (_e, height) => {
  if (!height) return cards.hide();
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  cards.setBounds({ x: workArea.x + workArea.width - CARD_WIDTH - 4, y: workArea.y + 4, width: CARD_WIDTH, height: Math.min(height, workArea.height - 8) });
  if (!cards.isVisible()) cards.showInactive();
});

function setBadge(text) {
  badge = text || '';
  // "!" means no token or a failed poll; a number is how many PRs need you.
  tray?.setTitle(badge ? ` ${badge}` : '', { fontType: 'monospacedDigit' });
  tray?.setToolTip(badge === '!' ? 'PR Radar: needs attention (open it to see why)' : badge ? `PR Radar: ${badge} PR${badge === '1' ? '' : 's'} need you` : 'PR Radar');
}

// ─── Sharing settings with the Chrome extension ─────────────────────────
// Chrome lets an extension talk to a local program only through a native
// messaging host it finds by manifest, and only for the extension IDs that
// manifest lists. The app writes the host and the manifests on every start,
// so they always point at the app's current location.
const HOST_NAME = 'dev.prradar.host';

// The extension's ID, derived as Chrome does from the public key in its
// manifest (sha256, first 32 hex digits, 0-f read as a-p).
function extensionId() {
  const { key } = JSON.parse(readFileSync(join(DIR, 'ext', 'manifest.json'), 'utf8'));
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// Where each Chromium browser looks for per-user native messaging hosts.
// Only browsers that are installed (their folder exists) get a manifest.
function hostFolders() {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.config');
  const browsers =
    process.platform === 'darwin'
      ? ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Arc/User Data']
      : ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'];
  const found = browsers.map((b) => join(base, b)).filter(existsSync);
  // Tests add a browser profile of their own.
  const extra = (process.env.PR_RADAR_NM_DIRS || '').split(':').filter(Boolean);
  return [...found.map((d) => join(d, 'NativeMessagingHosts')), ...extra];
}

const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function installHost() {
  const dir = join(app.getPath('userData'), 'native-host');
  mkdirSync(dir, { recursive: true });
  // Copied out of the app bundle: Chrome runs the host as a plain program,
  // so its files can't live inside the packed app archive.
  for (const f of ['host.cjs', 'shared-store.cjs']) writeFileSync(join(dir, f), readFileSync(join(DIR, f)));
  const script = join(dir, 'pr-radar-host');
  writeFileSync(script, `#!/bin/sh\nPR_RADAR_DIR=${sh(app.getPath('userData'))} ELECTRON_RUN_AS_NODE=1 exec ${sh(process.execPath)} ${sh(join(dir, 'host.cjs'))} "$@"\n`);
  chmodSync(script, 0o755);
  const manifest = { name: HOST_NAME, description: 'PR Radar: settings shared with the menu bar app', path: script, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId()}/`] };
  const installed = [];
  for (const folder of hostFolders()) {
    try {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${HOST_NAME}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
      installed.push(folder);
    } catch (e) {
      console.error(`PR Radar: could not register the extension helper in ${folder}`, e);
    }
  }
  return installed;
}

function contextMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open PR Radar', click: togglePanel },
    { label: 'Refresh now', click: () => host.message({ type: 'refresh' }) },
    { label: 'Settings…', accelerator: 'Command+,', click: openSettings },
    { type: 'separator' },
    { label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Quit PR Radar', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}

ipcMain.handle('storage:get', (_e, area, keys) => storage[area].get(keys));
ipcMain.handle('storage:set', (_e, area, items) => storage[area].set(items));
ipcMain.handle('runtime:message', (_e, msg) => host.message(msg));
ipcMain.handle('open-settings', () => openSettings());
ipcMain.handle('tabs:query', (_e, q) => host.tabsQuery(q));
ipcMain.handle('net:fetch', async (_e, url, init) => {
  const res = await fetch(url, init);
  const empty = res.status === 204 || res.status === 304;
  return { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), body: empty ? null : await res.text() };
});

// A menu bar app has no windows most of the time; that is not a reason to quit.
app.on('window-all-closed', () => {});
app.on('second-instance', togglePanel);

app.whenReady().then(async () => {
  await initStorage();
  app.dock?.hide();
  // Without an Edit menu, Cmd+V and friends don't work in the windows'
  // text fields on macOS (pasting the token, for one).
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  const icon = nativeImage.createFromPath(join(DIR, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', togglePanel);
  tray.on('right-click', () => tray.popUpContextMenu(contextMenu()));
  tray.setContextMenu(process.platform === 'darwin' ? null : contextMenu());
  const browsers = installHost();
  await storage.local.set({ sharedStatus: { mode: 'app', state: 'connected', file: shared.file, browsers: browsers.length } });
  host.onBadge(setBadge);
  setBadge('');
  globalThis.chrome = chrome;
  await import('./ext/background.js');
  host.startup();
  // Read by the end-to-end test; harmless otherwise.
  globalThis.prRadar = { togglePanel, openSettings, storage, badge: () => badge, panel: () => panel, settings: () => settings, cards: () => cards };
});
