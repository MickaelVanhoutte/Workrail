// App views shown right of the rail: Google apps (shared signed-in session)
// and local panels. Views are created on first use and kept alive.
const { WebContentsView, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const RAIL_W = 80; // keep in sync with .rail width in shell/rail.css
const PARTITION = 'persist:gchat';
const INJECT_DIR = path.join(__dirname, 'inject');

const CHAT_URL = 'https://chat.google.com/';
const SIGNIN_URL = `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(CHAT_URL)}`;

const VIEWS = {
  home: { file: 'panels/home.html' },
  chat: { url: CHAT_URL },
  gmail: { url: 'https://mail.google.com/mail/u/0/' },
  calendar: { url: 'https://calendar.google.com/calendar/u/0/r' },
  github: { file: 'panels/github.html' },
  // Same session as Google: company SSO often goes through Google.
  jira: { url: () => `https://${settings.get('jiraSite')}/jira/your-work` },
  settings: { file: 'panels/settings.html' },
};

const host = (url) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

const isGoogle = (url) => {
  const h = host(url)?.hostname || '';
  return h === 'google.com' || h.endsWith('.google.com') || h.endsWith('.gstatic.com');
};
const isAccounts = (url) => host(url)?.hostname === 'accounts.google.com';

// Which view a URL belongs to: 'self' (sign-in, stays where it is), a view
// name, or null (open in the default browser).
function routeFor(url) {
  const u = host(url);
  if (!u) return null;
  if (u.hostname === 'accounts.google.com') return 'self';
  if (u.hostname === 'chat.google.com' || (u.hostname === 'mail.google.com' && u.pathname.startsWith('/chat'))) return 'chat';
  if (u.hostname === 'mail.google.com') return 'gmail';
  if (u.hostname === 'calendar.google.com') return 'calendar';
  if (settings.get('jiraSite') && u.hostname === settings.get('jiraSite')) return 'jira';
  // Atlassian login steps stay in the view doing the login.
  if (['id.atlassian.com', 'auth.atlassian.com'].includes(u.hostname)) return 'self';
  return null;
}

// Signed-out chat.google.com redirects to this marketing page.
const isMarketing = (url) => /^https:\/\/workspace\.google\.com\/.*products\/chat/.test(url);

// --- Chat injection ----------------------------------------------------------

const readInject = (name) => fs.readFileSync(path.join(INJECT_DIR, name), 'utf8');

// Swap Lato in behind Google's font names instead of overriding
// font-family on elements, so icon fonts (Material Icons, Google Symbols)
// are untouched. Data URIs because the page CSP blocks other font sources.
const FONT_FAMILIES = ['Google Sans', 'Google Sans Text', 'Google Sans Flex', 'Roboto', 'Lato'];
const FONT_FACES = [
  { file: 'lato-latin-400-normal.woff2', weight: '100 549', style: 'normal' },
  { file: 'lato-latin-700-normal.woff2', weight: '550 849', style: 'normal' },
  { file: 'lato-latin-900-normal.woff2', weight: '850 1000', style: 'normal' },
  { file: 'lato-latin-400-italic.woff2', weight: '100 1000', style: 'italic' },
];
let fontCss = null;
function getFontCss() {
  if (fontCss) return fontCss;
  const faces = FONT_FACES.map((f) => ({
    ...f,
    src: fs.readFileSync(path.join(__dirname, 'fonts', f.file)).toString('base64'),
  }));
  fontCss = FONT_FAMILIES.flatMap((family) => faces.map((f) =>
    `@font-face{font-family:"${family}";font-weight:${f.weight};font-style:${f.style};` +
    `font-display:swap;src:url(data:font/woff2;base64,${f.src}) format("woff2");}`)).join('\n');
  return fontCss;
}

function createViews(win, { userAgent, dev, onShow, onReady }) {
  const views = new Map(); // name → WebContentsView
  const css = new Map(); // webContents id → { theme, font }
  let active = null;
  let fontsOn = true;

  const nameOf = (wc) => [...views].find(([, v]) => v.webContents === wc)?.[0] || null;

  async function applyFonts(wc) {
    const keys = css.get(wc.id) || {};
    if (keys.font) await wc.removeInsertedCSS(keys.font).catch(() => {});
    keys.font = fontsOn ? await wc.insertCSS(getFontCss()) : null;
    css.set(wc.id, keys);
  }

  async function inject(name, wc) {
    const url = wc.getURL();
    if (!isGoogle(url) || isAccounts(url)) return;
    try {
      await wc.executeJavaScript(readInject('notify.js'));
      if (name !== 'chat') return;
      const keys = css.get(wc.id) || {};
      if (keys.theme) await wc.removeInsertedCSS(keys.theme).catch(() => {});
      keys.theme = await wc.insertCSS(readInject('theme.css'));
      css.set(wc.id, keys);
      await applyFonts(wc);
      await wc.executeJavaScript(readInject('app.js'));
    } catch (err) {
      console.error(`[inject:${name}]`, err);
    }
  }

  function layout() {
    const [width, height] = win.getContentSize();
    for (const v of views.values()) v.setBounds({ x: RAIL_W, y: 0, width: Math.max(0, width - RAIL_W), height });
  }

  function open(name, url) {
    show(name);
    views.get(name).webContents.loadURL(url);
  }

  function wireGoogle(name, wc) {
    wc.setUserAgent(userAgent);
    wc.on('dom-ready', () => {
      inject(name, wc);
      onReady?.(name);
    });
    if (name === 'chat') {
      wc.on('did-navigate', (_e, url) => {
        if (isMarketing(url)) wc.loadURL(SIGNIN_URL);
      });
    }

    wc.setWindowOpenHandler(({ url }) => {
      const route = routeFor(url);
      if (route === 'self') {
        wc.loadURL(url);
        return { action: 'deny' };
      }
      // Gmail / Calendar pop-outs (compose window, print…) stay real popups.
      if (route === name && name !== 'chat') {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 720 } };
      }
      if (route) {
        open(route, url);
        return { action: 'deny' };
      }
      if (!url || url === 'about:blank') {
        // Some links open a blank window and set its location afterwards.
        return { action: 'allow', overrideBrowserWindowOptions: { show: false } };
      }
      shell.openExternal(url);
      return { action: 'deny' };
    });

    wc.on('did-create-window', (child) => {
      const redirect = (e, url) => {
        if (!url || url === 'about:blank') return;
        const route = routeFor(url);
        // Real popup of this app: let it be.
        if (route === name && name !== 'chat') return child.show();
        e?.preventDefault?.();
        if (route && route !== 'self') open(route, url);
        else if (route === 'self') return child.show();
        else shell.openExternal(url);
        child.destroy();
      };
      child.webContents.on('will-navigate', redirect);
      child.webContents.on('did-navigate', (e, url) => redirect(null, url));
    });
  }

  function wireLocal(wc) {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (!url.startsWith('file://')) {
        e.preventDefault();
        if (/^https:\/\//.test(url)) shell.openExternal(url);
      }
    });
  }

  function ensure(name) {
    if (views.has(name)) return views.get(name);
    const def = VIEWS[name];
    const local = !!def.file;
    const view = new WebContentsView({
      webPreferences: {
        partition: local ? undefined : PARTITION,
        preload: path.join(__dirname, local ? 'shell/preload.js' : 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: !local,
      },
    });
    view.setBackgroundColor('#ffffff');
    views.set(name, view);
    win.contentView.addChildView(view);
    const wc = view.webContents;
    if (local) wireLocal(wc);
    else wireGoogle(name, wc);
    wc.on('render-process-gone', (_e, details) => {
      console.error(`[${name}] renderer gone:`, details.reason);
      if (details.reason !== 'clean-exit') wc.reload();
    });
    layout();
    if (local) wc.loadFile(path.join(__dirname, def.file));
    else wc.loadURL(typeof def.url === 'function' ? def.url() : def.url);
    return view;
  }

  function show(name) {
    if (!VIEWS[name]) return;
    // Jira without a site yet: go set it up.
    if (name === 'jira' && !settings.get('jiraSite')) name = 'settings';
    const view = ensure(name);
    for (const [n, v] of views) v.setVisible(n === name);
    active = name;
    view.webContents.focus();
    onShow?.(name);
  }

  function send(name, channel, ...args) {
    const wc = views.get(name)?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
  }

  if (dev) {
    let t = null;
    fs.watch(INJECT_DIR, () => {
      clearTimeout(t);
      t = setTimeout(() => views.has('chat') && inject('chat', views.get('chat').webContents), 150);
    });
  }

  win.on('resize', layout);

  return {
    show,
    open,
    send,
    layout,
    nameOf,
    active: () => active,
    webContents: (name) => views.get(name)?.webContents || null,
    activeWebContents: () => views.get(active)?.webContents || null,
    setFonts(on, wc) {
      if (fontsOn === on) return;
      fontsOn = on;
      applyFonts(wc);
    },
  };
}

module.exports = { createViews, VIEWS, RAIL_W, isGoogle };
