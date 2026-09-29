const { contextBridge, ipcRenderer } = require('electron');

// Bridge for local pages: the rail (shell/rail.html) and panels
// (panels/home.html, panels/github.html, panels/settings.html).
contextBridge.exposeInMainWorld('gslackShell', {
  getState: () => ipcRenderer.invoke('shell:get-state'),
  onState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('shell:state', listener);
    return () => ipcRenderer.removeListener('shell:state', listener);
  },
  select: (name) => ipcRenderer.send('shell:select', String(name)),
  openExternal: (url) => ipcRenderer.send('shell:open-external', String(url)),
  // Home actions: { type: 'meet'|'pr'|'mail'|'chat'|'view', url?, id?, name? }
  action: (a) => ipcRenderer.send('shell:action', a),
  refresh: (what) => ipcRenderer.send('shell:refresh', String(what)),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
});
