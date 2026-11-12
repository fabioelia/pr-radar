import assert from 'node:assert/strict';
import test from 'node:test';

// A fake chrome: storage.local with onChanged, and a native host backed by a
// plain object standing in for the Mac app's config.json.
function fakeChrome({ host = null } = {}) {
  const data = {};
  const listeners = [];
  const sent = [];
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]]));
        },
        async set(items) {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: data[k], newValue: v };
            data[k] = v;
          }
          await Promise.resolve();
          for (const fn of listeners) fn(changes, 'local');
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: {
      async sendNativeMessage(_name, msg) {
        if (!host) throw new Error('Specified native messaging host not found.');
        sent.push(msg.type);
        if (msg.type === 'get') return { ok: true, config: host.config ?? null, token: host.token ?? '', updatedAt: host.updatedAt || 0, file: '/x/config.json' };
        if ('config' in msg) host.config = msg.config;
        if ('token' in msg) host.token = msg.token;
        host.updatedAt = (host.updatedAt || 0) + 1;
        return { ok: true, updatedAt: host.updatedAt, file: '/x/config.json' };
      },
    },
  };
  return { data, sent, host };
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const load = async () => import(`../shared.js?${Math.random()}`);

test('pulls newer shared settings and does not echo them back', async () => {
  const { data, sent } = fakeChrome({ host: { config: { pollMinutes: 4 }, token: 'ghp_app', updatedAt: 5 } });
  const { pullShared, shareLocalChanges } = await load();
  shareLocalChanges();
  await pullShared();
  await settle();
  assert.deepEqual([data.config, data.token, data.sharedAt, data.sharedStatus.state], [{ pollMinutes: 4 }, 'ghp_app', 5, 'connected']);
  assert.deepEqual(sent, ['get'], 'applying the pull sent nothing back');
});

test('a local save is pushed to the shared copy', async () => {
  const { data, host } = fakeChrome({ host: { config: { pollMinutes: 4 }, token: 'ghp_app', updatedAt: 5 } });
  const { pullShared, shareLocalChanges } = await load();
  shareLocalChanges();
  await pullShared();
  await chrome.storage.local.set({ config: { pollMinutes: 7 } });
  await settle();
  assert.deepEqual(host.config, { pollMinutes: 7 });
  assert.equal(data.sharedAt, host.updatedAt);
});

test('without the app: status says so, edits are marked, and they go out once it is reachable', async () => {
  const env = fakeChrome();
  const { pullShared, shareLocalChanges } = await load();
  shareLocalChanges();
  await pullShared();
  assert.equal(env.data.sharedStatus.state, 'unavailable');
  await chrome.storage.local.set({ config: { pollMinutes: 6 }, token: 'ghp_local' });
  await settle();
  assert.equal(env.data.sharedDirty, true);
  // The app gets installed with an older copy: the offline edit wins.
  const host = { config: { pollMinutes: 2 }, token: 'ghp_old', updatedAt: 0 };
  const original = chrome.runtime.sendNativeMessage;
  chrome.runtime.sendNativeMessage = async (name, msg) => {
    if (msg.type === 'get') return { ok: true, ...host, file: '/x/config.json' };
    Object.assign(host, 'config' in msg ? { config: msg.config } : {}, 'token' in msg ? { token: msg.token } : {}, { updatedAt: host.updatedAt + 1 });
    return { ok: true, updatedAt: host.updatedAt, file: '/x/config.json' };
  };
  await pullShared();
  assert.deepEqual([host.config, host.token, env.data.sharedDirty, env.data.sharedStatus.state], [{ pollMinutes: 6 }, 'ghp_local', false, 'connected']);
  chrome.runtime.sendNativeMessage = original;
});

test('an empty shared copy is seeded from the extension', async () => {
  const host = {};
  const env = fakeChrome({ host });
  await chrome.storage.local.set({ config: { pollMinutes: 3 }, token: 'ghp_ext' });
  const { pullShared } = await load();
  await pullShared();
  assert.deepEqual([host.config, host.token, env.data.sharedAt], [{ pollMinutes: 3 }, 'ghp_ext', 1]);
});

test('inside the Mac app (no native messaging) it does nothing', async () => {
  const env = fakeChrome();
  delete chrome.runtime.sendNativeMessage;
  const { pullShared, shareLocalChanges } = await load();
  shareLocalChanges();
  await pullShared();
  assert.deepEqual(env.data, {});
});
