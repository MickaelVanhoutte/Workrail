// Per-OS differences in one place: window chrome, unread badge, user agent,
// icons. macOS keeps its native look (traffic lights over the rail);
// Windows/Linux get a dark title-bar overlay with the controls top-right and
// a tray icon, since closing the window only hides it.
const { app, nativeImage } = require('electron');
const path = require('path');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

// Height of the dark top bar (Chat's top bar, panels' top strip). Off macOS
// the window controls overlay sits in it, top right.
const TOPBAR_H = 44;
// Room the overlay's buttons take on the right (Windows: 3 × 46px).
const CONTROLS_W = IS_MAC ? 0 : 150;

const ASSETS = path.join(__dirname, 'assets');
const asset = (name) => path.join(ASSETS, name);

// Google refuses sign-in from "embedded browsers". Present as plain Chrome
// for this OS, matching the bundled Chromium version.
function chromeUserAgent() {
  const os = IS_MAC ? 'Macintosh; Intel Mac OS X 10_15_7'
    : IS_WIN ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

function windowChrome() {
  if (IS_MAC) return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 13, y: 16 } };
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0e0e', symbolColor: '#ffffff', height: TOPBAR_H },
    icon: asset('icon.png'),
  };
}

let badgeImage = null;

// Unread count on the Dock (macOS), taskbar overlay (Windows) or launcher
// (Linux desktops that support it).
function setBadge(win, n) {
  if (IS_MAC) return app.dock?.setBadge(n > 0 ? String(n) : '');
  if (IS_WIN) {
    if (!win || win.isDestroyed()) return;
    badgeImage ??= nativeImage.createFromPath(asset('badge.png'));
    win.setOverlayIcon(n > 0 ? badgeImage : null, n > 0 ? `${n} unread` : '');
    return;
  }
  app.setBadgeCount(n > 0 ? n : 0);
}

// Something new while the window is in the background.
function requestAttention(win) {
  if (IS_MAC) return app.dock?.bounce('informational');
  if (win && !win.isDestroyed()) {
    win.flashFrame(true);
    win.once('focus', () => win.flashFrame(false));
  }
}

// Shortcut label shown in tooltips / README-style hints.
const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+';

module.exports = {
  IS_MAC, IS_WIN, IS_LINUX, TOPBAR_H, CONTROLS_W, MOD_LABEL,
  asset, chromeUserAgent, windowChrome, setBadge, requestAttention,
};
