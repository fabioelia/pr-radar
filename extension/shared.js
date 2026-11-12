// Keeps the extension's config and token in step with the PR Radar Mac app,
// through the native messaging host the app installs (mac/host.cjs). The
// shared copy lives in the app's config.json and the macOS keychain. Without
// the app nothing changes: the extension keeps its own settings and settings
// shows sharing as not connected. The Mac app runs this file too, and there
// chrome.runtime.sendNativeMessage doesn't exist, so it does nothing.
const HOST = 'dev.prradar.host';
const native = (msg) => chrome.runtime.sendNativeMessage(HOST, msg);
const json = (v) => JSON.stringify(v ?? null);

// The values last taken from the shared copy, so applying them doesn't echo
// them straight back. ponytail: in memory, so a restarted service worker may
// write one unchanged copy back, which is harmless.
const pulled = { config: undefined, token: undefined };

async function setStatus(status) {
  await chrome.storage.local.set({ sharedStatus: { mode: 'extension', at: Date.now(), ...status } });
}

// Takes the shared copy when it is newer than what this extension last
// synced; sends local edits made while the app wasn't reachable; seeds an
// empty shared copy from the extension's settings.
export async function pullShared() {
  if (!chrome.runtime.sendNativeMessage) return;
  let r;
  try {
    r = await native({ type: 'get' });
    if (!r?.ok) throw new Error(r?.error || 'no reply from the PR Radar app');
  } catch (e) {
    return setStatus({ state: 'unavailable', error: String(e.message || e) });
  }
  const { sharedAt = 0, sharedDirty, config, token } = await chrome.storage.local.get(['sharedAt', 'sharedDirty', 'config', 'token']);
  const empty = !r.config && !r.token;
  if ((empty && (config || token)) || (sharedDirty && r.updatedAt <= sharedAt)) return push({ config, token });
  const next = { sharedAt: r.updatedAt, sharedDirty: false };
  if (r.updatedAt > sharedAt) {
    if (r.config && json(r.config) !== json(config)) next.config = pulled.config = r.config;
    if (r.token && r.token !== token) next.token = pulled.token = r.token;
  }
  await chrome.storage.local.set(next);
  await setStatus({ state: 'connected', file: r.file });
}

async function push(items) {
  const msg = { type: 'set' };
  if (items.config !== undefined) msg.config = items.config;
  if (items.token !== undefined) msg.token = items.token || '';
  try {
    const r = await native(msg);
    if (!r?.ok) throw new Error(r?.error || 'no reply from the PR Radar app');
    await chrome.storage.local.set({ sharedAt: r.updatedAt, sharedDirty: false });
    await setStatus({ state: 'connected', file: r.file });
  } catch (e) {
    await chrome.storage.local.set({ sharedDirty: true });
    await setStatus({ state: 'unavailable', error: String(e.message || e) });
  }
}

// Sends every local change to config or token, except one that only applied
// what pullShared just took from the shared copy.
export function shareLocalChanges() {
  if (!chrome.runtime.sendNativeMessage) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const items = {};
    if (changes.config && json(changes.config.newValue) !== json(pulled.config)) items.config = changes.config.newValue;
    if (changes.token && (changes.token.newValue || '') !== (pulled.token || '')) items.token = changes.token.newValue || '';
    if (Object.keys(items).length) push(items);
  });
}
