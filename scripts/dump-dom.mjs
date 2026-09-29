// Dump the structure of the live Google Chat page (app started with
// `npm run dev`) so selectors in src/inject/ can be tuned.
//
// Usage: npm run dump -- [out-file] [--js "expression"] [--shot file.png]
//                          [--target chat|gmail|calendar|jira|home|github|settings|rail]
// Output keeps tags, roles, aria-labels, data-* attributes and short text
// snippets. It contains your chat content: keep it local.

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const jsIdx = args.indexOf('--js');
const customJs = jsIdx >= 0 ? args.splice(jsIdx, 2)[1] : null;
const shotIdx = args.indexOf('--shot');
const shotFile = shotIdx >= 0 ? args.splice(shotIdx, 2)[1] : null;
const targetIdx = args.indexOf('--target');
const target = targetIdx >= 0 ? args.splice(targetIdx, 2)[1] : 'chat';
const TARGETS = {
  chat: /^https:\/\/chat\.google\.com/,
  gmail: /^https:\/\/mail\.google\.com\/mail/,
  calendar: /^https:\/\/calendar\.google\.com/,
  home: /panels\/home\.html$/,
  jira: /atlassian\.net/,
  github: /panels\/github\.html$/,
  settings: /panels\/settings\.html$/,
  rail: /shell\/rail\.html$/,
};
const outFile = args[0] || 'chat.dump.txt';

const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json()).catch(() => {
  console.error('Cannot reach 127.0.0.1:9222 — start the app with `npm run dev` first.');
  process.exit(1);
});
const page = targets.find((t) => t.type === 'page' && (TARGETS[target] || TARGETS.chat).test(t.url));
if (!page) {
  console.error(`No "${target}" page found. Targets:`, targets.map((t) => t.url));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params) => new Promise((res) => {
  pending.set(++id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

if (shotFile) {
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotFile, Buffer.from(result.data, 'base64'));
  console.log(`Wrote screenshot to ${shotFile}`);
  ws.close();
  process.exit(0);
}

const walker = `(() => {
  const MAX_DEPTH = 40, TEXT = 60;
  const out = [];
  const keep = (el) => el.id || el.getAttribute('role') || el.getAttribute('aria-label') ||
    [...el.attributes].some((a) => a.name.startsWith('data-')) ||
    ['A','BUTTON','INPUT','TEXTAREA','IFRAME','MAIN','NAV','HEADER','C-WIZ'].includes(el.tagName) ||
    el.isContentEditable;
  const trunc = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const walk = (el, depth) => {
    if (depth > MAX_DEPTH || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    let d = depth;
    if (keep(el)) {
      const attrs = [];
      if (el.id) attrs.push('#' + el.id);
      for (const a of el.attributes) {
        if (a.name === 'role' || a.name.startsWith('aria-') || a.name.startsWith('data-') || a.name === 'href' || a.name === 'jsname')
          attrs.push(a.name + '=' + JSON.stringify(trunc(a.value, TEXT)));
      }
      const cls = el.classList.length ? ' .' + [...el.classList].slice(0, 3).join('.') : '';
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
      const r = el.getBoundingClientRect();
      const box = r.width ? ' [' + [r.x, r.y, r.width, r.height].map(Math.round).join(',') + ']' : ' [hidden]';
      out.push('  '.repeat(depth) + el.tagName.toLowerCase() + cls + ' ' + attrs.join(' ') + box + (own ? ' "' + trunc(own, TEXT) + '"' : ''));
      d = depth + 1;
    }
    for (const c of el.children) walk(c, d);
    if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, d);
  };
  walk(document.body, 0);
  const frames = [...document.querySelectorAll('iframe')].map((f) => f.src || f.name || '(inline)');
  return 'URL: ' + location.href + '\\nTITLE: ' + document.title + '\\nIFRAMES: ' + frames.join(', ') + '\\n\\n' + out.join('\\n');
})()`;

const { result } = await send('Runtime.evaluate', {
  expression: customJs || walker,
  returnByValue: true,
  awaitPromise: true,
});
const value = result?.result?.value ?? JSON.stringify(result, null, 2);
const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

if (customJs) console.log(text);
else {
  writeFileSync(outFile, text);
  console.log(`Wrote ${text.split('\n').length} lines to ${outFile}`);
}
ws.close();
