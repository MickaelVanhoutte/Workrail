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
  // Message chips overlay (panels/chips.html)
  onChip: (cb) => {
    const listener = (_e, chip) => cb(chip);
    ipcRenderer.on('chips:add', listener);
    return () => ipcRenderer.removeListener('chips:add', listener);
  },
  chipsSize: (h) => ipcRenderer.send('chips:size', Number(h) || 0),
  openChip: (source, id) => ipcRenderer.send('chips:open', { source: String(source), id: String(id) }),
  // Home's Messages feed: open a message's conversation; dismiss one
  // (feed id or conversation id) or 'all', which marks it read in Chat →
  // { ok, failed }
  feedOpen: (id) => ipcRenderer.send('feed:open', String(id)),
  feedDismiss: (target) => ipcRenderer.invoke('feed:dismiss', String(target)),
  // Work item hub: open a key (from any panel), load its data, and the
  // messages main sends to the hub page.
  openItem: (key) => ipcRenderer.send('item:open', String(key)),
  loadItem: (key, opts) => ipcRenderer.invoke('item:load', String(key), opts || {}),
  onOpenItem: (cb) => {
    const listener = (_e, key) => cb(key);
    ipcRenderer.on('item:open', listener);
    return () => ipcRenderer.removeListener('item:open', listener);
  },
  onFocusSearch: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('item:focus-search', listener);
    return () => ipcRenderer.removeListener('item:focus-search', listener);
  },
  onOpenStandup: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('home:open-standup', listener);
    return () => ipcRenderer.removeListener('home:open-standup', listener);
  },
});
