const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the scripts injected into Google views
// (src/inject/notify.js everywhere, src/inject/app.js in Chat).
contextBridge.exposeInMainWorld('gslack', {
  setUnread: (n) => ipcRenderer.send('gslack:unread', Number(n) || 0),
  // Unread conversations for Home: [{ id, name, kind, notifications }]
  setConversations: (list) => ipcRenderer.send('gslack:conversations', list),
  notificationShown: () => ipcRenderer.send('gslack:notification'),
  notificationClicked: () => ipcRenderer.send('gslack:notification-click'),
  themeChanged: (on) => ipcRenderer.send('gslack:theme', !!on),
  openExternal: (url) => ipcRenderer.send('gslack:open-external', String(url)),
  // Next meeting for the top-bar pill: { title, start, end, meetUrl, ongoing } | null
  onNextMeeting: (cb) => {
    const listener = (_e, next) => cb(next);
    ipcRenderer.on('gslack:next-meeting', listener);
    return () => ipcRenderer.removeListener('gslack:next-meeting', listener);
  },
  // Whether this view is really looked at, and how its notifications should
  // surface: { hidden: boolean, mode: 'native' | 'chip' }
  onVisibility: (cb) => {
    const listener = (_e, v) => cb(v);
    ipcRenderer.on('gslack:visibility', listener);
    return () => ipcRenderer.removeListener('gslack:visibility', listener);
  },
  requestVisibility: () => ipcRenderer.send('gslack:visibility-request'),
  // In-app chip for a notification the page created: { id, title, body, icon, tag, data }
  showChip: (chip) => ipcRenderer.send('gslack:chip', chip),
  onChipClick: (cb) => {
    const listener = (_e, id) => cb(id);
    ipcRenderer.on('gslack:chip-click', listener);
    return () => ipcRenderer.removeListener('gslack:chip-click', listener);
  },
  log: (...args) => ipcRenderer.send('gslack:log', ...args.map(String)),
});
