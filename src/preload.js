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
  log: (...args) => ipcRenderer.send('gslack:log', ...args.map(String)),
});
