// The notification card window's only link to the app: cards in, clicks and
// its height out. Isolated, unlike the panel's preload, because the page
// needs nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cards', {
  onShow: (fn) => ipcRenderer.on('card:show', (_e, card) => fn(card)),
  onClear: (fn) => ipcRenderer.on('card:clear', (_e, id) => fn(id)),
  click: (id) => ipcRenderer.send('card:click', id),
  resize: (height) => ipcRenderer.send('card:size', height),
});
