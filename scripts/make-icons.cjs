// Renders the app icon (inline SVG below) to the PNGs the app and the
// installers need. Run with Electron: `npm run icons`. Outputs are committed.
//   build/icon.png         1024  electron-builder derives .icns / .ico from it
//   src/assets/icon.png     512  window icon on Windows / Linux
//   src/assets/tray.png      32  tray icon (+ tray@2x.png, 64)
//   src/assets/badge.png     16  Windows taskbar overlay (unread)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="64" y="64" width="896" height="896" rx="200" fill="#0e0e0e"/>
  <rect x="170" y="230" width="130" height="130" rx="34" fill="#ffffff"/>
  <rect x="170" y="430" width="130" height="130" rx="34" fill="#5a5a5a"/>
  <rect x="170" y="630" width="130" height="130" rx="34" fill="#5a5a5a"/>
  <circle cx="300" cy="232" r="46" fill="#f03f76" stroke="#0e0e0e" stroke-width="18"/>
  <rect x="380" y="200" width="500" height="624" rx="56" fill="#ffffff"/>
  <rect x="444" y="290" width="300" height="44" rx="22" fill="#1d1c1d"/>
  <rect x="444" y="384" width="372" height="30" rx="15" fill="#c7c7c7"/>
  <rect x="444" y="448" width="252" height="30" rx="15" fill="#c7c7c7"/>
  <rect x="444" y="584" width="190" height="72" rx="36" fill="#007a5a"/>
</svg>`;

const BADGE = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <circle cx="8" cy="8" r="7" fill="#f03f76" stroke="#ffffff" stroke-width="1.5"/>
</svg>`;

const OUTPUTS = [
  { svg: ICON, size: 1024, file: 'build/icon.png' },
  { svg: ICON, size: 512, file: 'src/assets/icon.png' },
  { svg: ICON, size: 32, file: 'src/assets/tray.png' },
  { svg: ICON, size: 64, file: 'src/assets/tray@2x.png' },
  { svg: BADGE, size: 16, file: 'src/assets/badge.png' },
];

// One offscreen window, resized per output (fresh windows per render fail
// intermittently when loading data: URLs).
let win = null;
async function render(svg, size) {
  win ??= new BrowserWindow({
    show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    useContentSize: true, webPreferences: { offscreen: true },
  });
  win.setContentSize(size, size);
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}">
  </body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage();
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const { svg, size, file } of OUTPUTS) {
    const out = path.join(ROOT, file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await render(svg, size));
    console.log(`${file} (${size}px)`);
  }
  app.quit();
});
