const { app, BrowserWindow, Menu, Notification, Tray, session, shell, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { createViews, VIEWS, isGoogle } = require('./views');
const gmail = require('./services/gmail');
const github = require('./services/github');
const calendar = require('./services/calendar');
const jira = require('./services/jira');
const priorities = require('./priorities');
const platform = require('./platform');

const DEV = process.argv.includes('--dev');
// CI check: open the window, load the local pages, exit (see README).
const SMOKE = process.argv.includes('--smoke');
// Isolated profile: never touches (or is blocked by) a running Workrail.
if (SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'workrail-smoke-')));
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

if (DEV) app.commandLine.appendSwitch('remote-debugging-port', '9222');

// Google refuses sign-in from "embedded browsers": present as plain Chrome.
const CHROME_UA = platform.chromeUserAgent();
app.userAgentFallback = CHROME_UA;
// Windows only shows toasts for apps with an explicit model id.
if (platform.IS_WIN) app.setAppUserModelId('app.workrail.desktop');

let win = null;
let views = null;
let tray = null;
let quitting = false;
let githubService = null;
let calendarService = null;
let gmailService = null;
let jiraService = null;
let googleSession = null;

// Everything the rail and local panels display.
const state = {
  active: 'home',
  user: { firstName: null },
  badges: { home: 0, chat: 0, gmail: 0, github: 0, jira: 0, calendar: '' },
  chat: { conversations: [] },
  gmail: { status: 'loading', important: null },
  github: { status: 'loading', reviews: [], mine: [] },
  calendar: { status: 'unconfigured', next: null, today: [] },
  jira: { status: 'loading', issues: [] },
  // Derived for the Home view (priorities.js), recomputed on every push.
  home: { actions: [], slots: [], summary: '' },
};

// --- window state -----------------------------------------------------------

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
  } catch {
    return { width: 1280, height: 820 };
  }
}

let saveTimer = null;
function saveWindowState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const s = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    fs.writeFile(STATE_FILE(), JSON.stringify(s), () => {});
  }, 400);
}

// --- shell state ------------------------------------------------------------

function computeHome(now = Date.now()) {
  state.home = {
    actions: priorities.actions(state, now),
    slots: state.calendar.status === 'ok' ? priorities.freeSlots(state.calendar.today, now, settings.get('workdayEnd')) : [],
    summary: priorities.summary(state, now),
  };
  // Home badge: things that really need you (meetings, DMs, my PRs, overdue reviews).
  state.badges.home = state.home.actions.filter((x) => x.score >= 70).length;
}

function pushState() {
  if (!win || win.isDestroyed()) return;
  computeHome();
  win.webContents.send('shell:state', state);
  for (const name of ['home', 'github', 'settings']) views?.send(name, 'shell:state', state);
}

function calendarBadge(next) {
  if (!next) return '';
  if (next.ongoing) return 'now';
  const mins = Math.round((next.start - Date.now()) / 60000);
  return mins <= 15 ? `${Math.max(mins, 0)}m` : '';
}

// Chat's own count drives the dock / taskbar badge, like Slack's mentions.
function setDockBadge(n) {
  platform.setBadge(win, n);
  tray?.setToolTip(n > 0 ? `Workrail · ${n} unread` : 'Workrail');
}

// Windows/Linux: closing the window hides it, so the tray brings it back.
function createTray() {
  if (platform.IS_MAC || tray) return;
  tray = new Tray(platform.asset('tray.png'));
  tray.setToolTip('Workrail');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Workrail', click: () => showWindow() },
    { label: 'Home', click: () => { showWindow(); views?.show('home'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showWindow());
}

// --- services ---------------------------------------------------------------

function startGithub() {
  githubService?.stop();
  githubService = null;
  if (!settings.get('github')) {
    state.github = { status: 'disabled', reviews: [], mine: [] };
    state.badges.github = 0;
    return pushState();
  }
  githubService = github.start({
    includeTeams: settings.get('githubTeams'),
    exclude: settings.get('githubExclude'),
    onUpdate: (data) => {
      state.github = data;
      // Badge: PRs from people (not bots) with activity in the last 30 days;
      // the rest only shows in the list.
      const recent = Date.now() - 30 * 86400000;
      state.badges.github = data.reviews.filter((p) => !p.bot && new Date(p.updatedAt).getTime() > recent).length;
      pushState();
    },
  });
}

// Tickets due today or overdue drive the rail badge.
function jiraBadge(issues) {
  const today = new Date().toLocaleDateString('sv-SE');
  return issues.filter((i) => i.due && i.due <= today).length;
}

function startJira() {
  jiraService?.stop();
  jiraService = null;
  if (!settings.get('jira') || !settings.get('jiraSite')) {
    state.jira = { status: settings.get('jira') ? 'unconfigured' : 'disabled', issues: [] };
    state.badges.jira = 0;
    return pushState();
  }
  jiraService = jira.start({
    ses: googleSession,
    site: settings.get('jiraSite'),
    jql: settings.get('jiraJql'),
    onUpdate: (data) => {
      state.jira = data;
      state.badges.jira = jiraBadge(data.issues);
      pushState();
    },
    onOpen: (url) => {
      showWindow();
      views?.open('jira', url);
    },
  });
}

function startServices(ses) {
  googleSession = ses;
  startJira();
  gmailService = gmail.start(ses, ({ unread, important, account }) => {
    state.badges.gmail = unread;
    state.gmail = { status: 'ok', important };
    // "jane.doe@…" → "Jane" for the Home greeting.
    const first = account?.split('@')[0].split(/[._-]/)[0];
    if (first) state.user.firstName = first.charAt(0).toUpperCase() + first.slice(1);
    pushState();
  });
  startGithub();
  calendarService = calendar.start({
    getUrl: settings.getIcalUrl,
    getLeadMinutes: () => settings.get('reminderMinutes'),
    onUpdate: ({ status, next, today }) => {
      state.calendar = { status, next, today: today || [] };
      state.badges.calendar = calendarBadge(next);
      views?.send('chat', 'gslack:next-meeting', next);
      pushState();
    },
  });
}

function refreshIfStale(maxAge = 60 * 1000) {
  const stale = (x) => x?.status === 'ok' && Date.now() - (x.updatedAt || 0) > maxAge;
  if (stale(state.github)) githubService?.refresh();
  if (stale(state.jira)) jiraService?.refresh();
}

// --- window -----------------------------------------------------------------

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setupGoogleSession() {
  const ses = session.fromPartition('persist:gchat');
  ses.setUserAgent(CHROME_UA);
  const allowed = ['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'];
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.includes(permission) && isGoogle(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.includes(permission) && isGoogle(origin));
  return ses;
}

function createWindow() {
  const ws = loadWindowState();

  win = new BrowserWindow({
    ...ws,
    minWidth: 760,
    minHeight: 480,
    title: 'Workrail',
    // macOS: traffic lights over the rail. Windows/Linux: dark overlay with
    // the controls top-right (platform.js).
    ...platform.windowChrome(),
    backgroundColor: '#0e0e0e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'shell/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (ws.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  win.on('focus', () => state.active === 'home' && refreshIfStale());
  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);

  // Slack behaviour: closing hides, ⌘Q / Ctrl+Q (or the tray) quits.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
    views = null;
  });

  win.loadFile(path.join(__dirname, 'shell/rail.html'));

  views = createViews(win, {
    userAgent: CHROME_UA,
    dev: DEV,
    onShow: (name) => {
      state.active = name;
      pushState();
      // Back on Home: don't show data older than a minute (merged PRs,
      // closed tickets).
      if (name === 'home') refreshIfStale();
    },
    onReady: (name) => {
      if (name === 'chat') views.send('chat', 'gslack:next-meeting', state.calendar.next);
      // Just signed in to Jira in its view: fetch tickets now.
      if (name === 'jira' && state.jira.status === 'auth') jiraService?.refresh();
    },
  });
  if (SMOKE) return runSmokeTest();
  // Chat always loads (dock badge, unread conversations for Home); the day
  // starts on Home.
  views.show('chat');
  views.show('home');
}

// --smoke: the rail and Home (local pages) must load; no network needed.
function runSmokeTest() {
  const fail = (why) => {
    console.error('[smoke] FAIL:', why);
    app.exit(1);
  };
  process.on('uncaughtException', (err) => fail(err.stack || err));
  setTimeout(() => fail('timeout'), 30000);
  const loaded = (wc) => new Promise((resolve, reject) => {
    wc.once('did-finish-load', resolve);
    wc.once('did-fail-load', (_e, code, desc) => reject(new Error(`${code} ${desc}`)));
  });
  const rail = loaded(win.webContents);
  views.show('home');
  Promise.all([rail, loaded(views.webContents('home'))])
    .then(() => views.webContents('home').executeJavaScript('document.getElementById("focus") ? "ok" : "missing"'))
    .then((res) => {
      if (res !== 'ok') return fail('Home did not render');
      console.log(`[smoke] OK on ${process.platform}`);
      app.exit(0);
    })
    .catch((err) => fail(err.message));
}

// --- morning summary ----------------------------------------------------------

const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
const keepAlive = new Set();
let summaryWaitSince = null;

function checkMorningSummary() {
  const time = settings.get('summaryTime');
  if (!time || time === 'off') return;
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6 || settings.get('lastSummaryDate') === today()) return;
  const [h, m] = time.split(':').map(Number);
  const late = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
  if (late < 0) return;
  // App opened long after the summary time: a "morning" summary at 6 pm
  // makes no sense, skip it for today.
  if (late > 180) return settings.set({ lastSummaryDate: today() });
  // Give the services a moment after launch (max 10 min) so the summary
  // isn't built from empty data.
  const loaded = state.github.status !== 'loading' && state.calendar.status !== 'loading';
  summaryWaitSince ??= Date.now();
  if (!loaded && Date.now() - summaryWaitSince < 10 * 60000) return;

  settings.set({ lastSummaryDate: today() });
  computeHome();
  const n = new Notification({ title: 'Your day', body: state.home.summary });
  keepAlive.add(n);
  n.on('click', () => {
    showWindow();
    views?.show('home');
  });
  n.on('close', () => keepAlive.delete(n));
  n.show();
}

// --- IPC: Google views (src/preload.js) ---------------------------------------

const fromView = (e, name) => views?.nameOf(e.sender) === name;
const fromLocal = (e) => (e.senderFrame?.url || '').startsWith('file://');
const safeOpen = (url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
};

ipcMain.on('gslack:unread', (e, n) => {
  if (!fromView(e, 'chat')) return;
  const count = Number.isFinite(n) ? n : 0;
  state.badges.chat = count;
  setDockBadge(count);
  pushState();
});
ipcMain.on('gslack:notification', () => {
  if (win && !win.isFocused()) platform.requestAttention(win);
});
ipcMain.on('gslack:notification-click', (e) => {
  showWindow();
  const name = views?.nameOf(e.sender);
  if (name) views.show(name);
});
ipcMain.on('gslack:theme', (e, on) => {
  if (fromView(e, 'chat')) views.setFonts(!!on, e.sender);
});
ipcMain.on('gslack:open-external', (_e, url) => safeOpen(url));
// Unread conversations published by inject/app.js (for Home).
const CONV_KINDS = ['dm', 'group', 'space', 'meeting'];
ipcMain.on('gslack:conversations', (e, list) => {
  if (!fromView(e, 'chat') || !Array.isArray(list)) return;
  state.chat.conversations = list.slice(0, 100)
    .filter((c) => c && typeof c.id === 'string' && /^(dm|space)\/[\w-]+$/.test(c.id) && CONV_KINDS.includes(c.kind))
    .map((c) => ({ id: c.id, name: String(c.name || '').slice(0, 120), kind: c.kind, notifications: Math.max(0, Number(c.notifications) || 0) }));
  pushState();
});
ipcMain.on('gslack:log', (_e, ...args) => DEV && console.log('[page]', ...args));

// --- IPC: rail and local panels (src/shell/preload.js) ------------------------

ipcMain.handle('shell:get-state', (e) => (fromLocal(e) ? state : null));
ipcMain.on('shell:select', (e, name) => {
  if (fromLocal(e) && VIEWS[name]) views?.show(name);
});
ipcMain.on('shell:open-external', (e, url) => fromLocal(e) && safeOpen(url));
// Home actions: join a meeting, open a PR / mail / conversation, switch view.
ipcMain.on('shell:action', (e, action) => {
  if (!fromLocal(e) || !action || !views) return;
  switch (action.type) {
    case 'meet':
    case 'pr':
      return safeOpen(action.url);
    case 'mail':
      if (typeof action.url === 'string' && /^https:\/\/mail\.google\.com\//.test(action.url)) views.open('gmail', action.url);
      else views.show('gmail');
      return;
    case 'chat':
      views.show('chat');
      if (typeof action.id === 'string' && /^(dm|space)\/[\w-]+$/.test(action.id)) {
        views.webContents('chat')?.executeJavaScript(`window.__gslack?.openGroup(${JSON.stringify(action.id)})`).catch(() => {});
      }
      return;
    case 'jira': {
      const site = settings.get('jiraSite');
      if (site && typeof action.url === 'string' && action.url.startsWith(`https://${site}/`)) views.open('jira', action.url);
      else views.show('jira');
      return;
    }
    case 'view':
      if (VIEWS[action.name]) views.show(action.name);
  }
});
ipcMain.on('shell:refresh', (e, what) => {
  if (!fromLocal(e)) return;
  if (what === 'github') githubService?.refresh();
  if (what === 'calendar') calendarService?.refresh();
  if (what === 'gmail') gmailService?.refresh();
  if (what === 'jira') jiraService?.refresh();
});
ipcMain.handle('settings:get', (e) => (fromLocal(e) ? settings.publicView() : null));
ipcMain.handle('settings:save', (e, patch) => {
  if (!fromLocal(e) || !patch || typeof patch !== 'object') return null;
  if ('icalUrl' in patch) {
    const url = String(patch.icalUrl || '').trim();
    if (url && !/^https:\/\/calendar\.google\.com\/calendar\/ical\//.test(url)) {
      return { error: 'This does not look like a Google Calendar iCal address (https://calendar.google.com/calendar/ical/…).' };
    }
    try {
      settings.setIcalUrl(url || null);
    } catch (err) {
      return { error: err.message };
    }
    calendarService?.refresh();
  }
  const rest = {};
  if ([0, 1, 2, 5].includes(patch.reminderMinutes)) rest.reminderMinutes = patch.reminderMinutes;
  if (typeof patch.github === 'boolean') rest.github = patch.github;
  if (typeof patch.githubTeams === 'boolean') rest.githubTeams = patch.githubTeams;
  if (patch.summaryTime === 'off' || /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.summaryTime)) rest.summaryTime = patch.summaryTime;
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.workdayEnd)) rest.workdayEnd = patch.workdayEnd;
  if (typeof patch.jira === 'boolean') rest.jira = patch.jira;
  if (typeof patch.jiraSite === 'string') {
    const site = patch.jiraSite.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (site && !/^[a-z0-9-]+\.atlassian\.net$/.test(site)) return { error: 'Jira site must look like yourcompany.atlassian.net' };
    rest.jiraSite = site;
  }
  if (typeof patch.jiraJql === 'string') rest.jiraJql = patch.jiraJql.trim().slice(0, 2000);
  if (Array.isArray(patch.githubExclude)) {
    rest.githubExclude = [...new Set(patch.githubExclude.map((p) => String(p).trim()).filter((p) => p && p.length <= 100))].slice(0, 50);
  }
  settings.set(rest);
  if ('github' in rest || 'githubTeams' in rest || 'githubExclude' in rest) startGithub();
  if ('workdayEnd' in rest) pushState();
  if ('jira' in rest || 'jiraSite' in rest || 'jiraJql' in rest) startJira();
  return settings.publicView();
});

// --- menu -------------------------------------------------------------------

const activeWc = () => views?.activeWebContents();

function buildMenu() {
  const go = (name) => () => {
    showWindow();
    views?.show(name);
  };
  // macOS app menu; elsewhere a plain File menu (the menu bar itself is
  // hidden by the title-bar overlay, the shortcuts still work).
  const appMenu = platform.IS_MAC
    ? {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: go('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }
    : {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'Ctrl+,', click: go('settings') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Ctrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    };
  const template = [
    appMenu,
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+1', click: go('home') },
        { label: 'Chat', accelerator: 'CmdOrCtrl+2', click: go('chat') },
        { label: 'Mail', accelerator: 'CmdOrCtrl+3', click: go('gmail') },
        { label: 'Calendar', accelerator: 'CmdOrCtrl+4', click: go('calendar') },
        { label: 'Reviews', accelerator: 'CmdOrCtrl+5', click: go('github') },
        { label: 'Jira', accelerator: 'CmdOrCtrl+6', click: go('jira') },
        { type: 'separator' },
        {
          label: 'Quick Switcher',
          accelerator: 'CmdOrCtrl+K',
          click: () => {
            views?.show('chat');
            views?.webContents('chat')?.executeJavaScript('window.__gslack?.openSwitcher()').catch(() => {});
          },
        },
        {
          label: 'Toggle Slack Theme',
          accelerator: 'CmdOrCtrl+Shift+,',
          click: () => views?.webContents('chat')?.executeJavaScript('window.__gslack?.toggleTheme()').catch(() => {}),
        },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => activeWc()?.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => activeWc()?.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => activeWc()?.reload() },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => activeWc()?.reloadIgnoringCache() },
        { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => activeWc()?.toggleDevTools() },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle --------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'system';
    const ses = setupGoogleSession();
    buildMenu();
    createWindow();
    if (SMOKE) return;
    createTray();
    startServices(ses);
    setInterval(checkMorningSummary, 60000);
    // Keep relative times on Home fresh even when no service reports.
    setInterval(pushState, 60000);
  });
  app.on('activate', showWindow);
  app.on('before-quit', () => (quitting = true));
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
