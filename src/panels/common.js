// Helpers shared by local panels (home.js, github.js). Loaded first as a
// classic script: defines globals.

// Build DOM without innerHTML: el('div', { class, text, ...attrs }, ...children)
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function waited(ts) {
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (d <= 0) return 'requested today';
  return d === 1 ? 'waiting 1 day' : `waiting ${d} days`;
}

// 24h clock ("14:30"): compact enough for the timeline column.
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const emptyState = (title, ...lines) => el('div', { class: 'empty' }, el('strong', { text: title }), ...lines);
