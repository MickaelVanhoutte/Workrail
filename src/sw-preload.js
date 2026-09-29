// Preload for Google's service workers (Chat, Gmail).
//
// Chat's service worker decides whether to notify by asking the browser if
// the Chat tab is visible / focused (clients.matchAll). Inside Workrail the
// page always looks visible and focused, even on another view or with the
// window in the background, so it never notifies. Two fixes:
// 1. Window clients report the state Workrail knows (main sends it).
// 2. showNotification is forwarded to the main process (Electron does not
//    display service-worker notifications), which shows a chip or a native
//    notification (main.js onServiceWorkerNotification).
const { contextBridge, ipcRenderer } = require('electron');

let state = { hidden: false };
ipcRenderer.on('sw:visibility', (_e, s) => {
  state = { hidden: !!s?.hidden };
});

contextBridge.executeInMainWorld({
  func: (forward, getState) => {
    const reg = self.registration;
    if (!reg || reg.__workrail) return;
    reg.__workrail = true;

    // --- 1. visibility seen by the worker
    const wrap = (client) => new Proxy(client, {
      get(target, prop) {
        if (prop === 'visibilityState' && getState().hidden) return 'hidden';
        if (prop === 'focused' && getState().hidden) return false;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const isWindow = (c) => typeof WindowClient !== 'undefined' && c instanceof WindowClient;
    const matchAll = self.clients.matchAll.bind(self.clients);
    self.clients.matchAll = (options) => matchAll(options).then((list) => list.map((c) => (isWindow(c) ? wrap(c) : c)));
    const get = self.clients.get.bind(self.clients);
    self.clients.get = (id) => get(id).then((c) => (c && isWindow(c) ? wrap(c) : c));

    // --- 2. notifications
    reg.showNotification = (title, options = {}) => {
      let data = null;
      try {
        data = JSON.stringify(options.data ?? null).slice(0, 4000);
      } catch {
        // not serialisable
      }
      forward({
        title: String(title || ''),
        body: String(options.body || ''),
        icon: String(options.icon || ''),
        tag: String(options.tag || ''),
        data,
      });
      return Promise.resolve();
    };
  },
  args: [(n) => ipcRenderer.send('sw:notification', n), () => state],
});
