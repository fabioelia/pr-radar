// Gives the extension's pages (sidepanel.html, options.html) the chrome.*
// calls they make, backed by the main process. Runs before the page's own
// scripts, in the page's world (contextIsolation is off for these local
// pages only), so `chrome` and `fetch` are in place when the modules load.
const { ipcRenderer } = require('electron');

const listeners = { storage: [], activated: [] };
ipcRenderer.on('storage-changed', (_e, changes, area) => listeners.storage.forEach((fn) => fn(changes, area)));
ipcRenderer.on('tabs-activated', () => listeners.activated.forEach((fn) => fn({})));

const area = (name) => ({
  get: (keys) => ipcRenderer.invoke('storage:get', name, keys),
  set: (items) => ipcRenderer.invoke('storage:set', name, items),
});

window.chrome = {
  storage: { local: area('local'), session: area('session'), onChanged: { addListener: (fn) => listeners.storage.push(fn) } },
  runtime: {
    sendMessage: (msg) => ipcRenderer.invoke('runtime:message', msg),
    openOptionsPage: () => ipcRenderer.invoke('open-settings'),
  },
  tabs: {
    query: (q) => ipcRenderer.invoke('tabs:query', q),
    onActivated: { addListener: (fn) => listeners.activated.push(fn) },
    onUpdated: { addListener: () => {} },
  },
};

// GitHub calls go through the main process: a page here isn't an extension,
// so CORS would block the job-log download (it redirects to Azure storage).
const pageFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('https://api.github.com/')) return pageFetch(input, init);
  const r = await ipcRenderer.invoke('net:fetch', url, { method: init.method, headers: init.headers, body: init.body });
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
};
