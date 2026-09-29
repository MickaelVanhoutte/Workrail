const { contextBridge, ipcRenderer } = require('electron');

// Bridge for local pages: the rail (shell/rail.html) and panels
// (panels/home.html, panels/github.html, panels/settings.html).
contextBridge.exposeInMainWorld('gslackShell', {
  // 'darwin' | 'win32' | 'linux': layout (window controls) and shortcut labels.
  platform: process.platform,
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
  // GitHub: { kind: 'approve'|'merge'|'rerun', repo, number, runId? } → { ok | cancelled | error }
  ghAction: (a) => ipcRenderer.invoke('gh:action', a),
  ciDetails: (repo, runId) => ipcRenderer.invoke('gh:ci-details', { repo, runId }),
  copy: (text) => ipcRenderer.invoke('clipboard:write', String(text)),
  // Jira: move a ticket (after a native confirmation in main)
  jiraTransition: (key, id) => ipcRenderer.invoke('jira:transition', { key, id }),
  jiraTransitions: (key) => ipcRenderer.invoke('jira:transitions', key),
  // Standup text: { text, lang, generatedAt } | { error }
  buildStandup: () => ipcRenderer.invoke('standup:build'),
  // AI agent hand-off: { kind: 'review'|'fix-ci', repo, number } | { kind: 'implement', key }
  handoff: (req) => ipcRenderer.invoke('agent:handoff', req),
  agentStatus: (opts) => ipcRenderer.invoke('agent:status', opts || {}),
  onOpenStandup: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('home:open-standup', listener);
    return () => ipcRenderer.removeListener('home:open-standup', listener);
  },
});
