// Building blocks shared by Home and the work item hub (home.js, item.js):
// actions through main, toast, icons, rows, chips, PR / ticket pills, CI
// failure details. Classic script loaded after common.js: defines globals.
const api = window.gslackShell;
const $ = (id) => document.getElementById(id);

const DAY = 86400000;
const PRIMARY = new Set(['Join', 'Merge']);
const MINE_LABEL = {
  ready: 'Ready', 'ci-failed': 'CI failed', changes: 'Changes', conflict: 'Conflict',
  'ci-pending': 'CI running', waiting: 'In review', draft: 'Draft',
};

let agentName = null; // chosen AI agent (Settings), null = none installed
const ciCache = new Map(); // runId → failed log excerpt

const todayStr = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local

// Actions that change something go through main (native confirmation) and
// report back here.
async function act(action) {
  if (action.type === 'gh') {
    return report(await api.ghAction(action), { merge: 'Merged', approve: 'Approved', rerun: 'Re-run started' }[action.kind]);
  }
  if (action.type === 'jira-move') return report(await api.jiraTransition(action.key, action.id), 'Ticket moved');
  if (action.type === 'handoff') {
    toast(`Starting ${agentName || 'the agent'}…`);
    return report(await api.handoff(action), (res) => `${res.agent} opened in a terminal`);
  }
  // A ticket opens its work item hub; raw (e.g. ⇧-click, "Open in Jira")
  // goes to the Jira view.
  const key = action.type === 'jira' && !action.raw ? String(action.url || '').match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)$/)?.[1] : null;
  if (key) return api.openItem(key);
  return api.action(action);
}

function report(res, okText) {
  if (!res || res.cancelled) return;
  if (res.error) toast(res.error, 'error');
  else toast(typeof okText === 'function' ? okText(res) : okText, 'ok');
}

let toastTimer = null;
function toast(text, kind = '') {
  let box = document.getElementById('toast');
  if (!box) {
    box = el('div', { id: 'toast', role: 'status' });
    document.body.append(box);
  }
  box.className = `toast show ${kind}`;
  box.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), kind === 'error' ? 7000 : 3500);
}
// --- icons (same stroke style as the rail) --------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  meeting: [['rect', { x: 4, y: 5.5, width: 16, height: 14.5, rx: 1.5 }], ['path', { d: 'M4 10h16M8.5 3.5v4M15.5 3.5v4' }]],
  chat: [['path', { d: 'M5 4.5h14A1.5 1.5 0 0 1 20.5 6v9.5A1.5 1.5 0 0 1 19 17H9.5l-5 4V6A1.5 1.5 0 0 1 5 4.5z' }]],
  group: [['circle', { cx: 9, cy: 9, r: 3 }], ['path', { d: 'M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5' }], ['circle', { cx: 16.5, cy: 9.5, r: 2.5 }], ['path', { d: 'M16 14.2c2.6.3 4.5 2.1 4.5 4.8' }]],
  pr: [['circle', { cx: 6.5, cy: 6, r: 2 }], ['circle', { cx: 6.5, cy: 18, r: 2 }], ['circle', { cx: 17.5, cy: 18, r: 2 }], ['path', { d: 'M6.5 8v8M17.5 16V9.5a3 3 0 0 0-3-3H11M13 4l-2.5 2.5L13 9' }]],
  review: [['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  mail: [['rect', { x: 3.5, y: 5.5, width: 17, height: 13, rx: 1.5 }], ['path', { d: 'M4 7l8 6 8-6' }]],
  free: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3 2' }]],
  ticket: [['path', { d: 'M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v2a2.5 2.5 0 0 0 0 5v2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-2a2.5 2.5 0 0 0 0-5z' }], ['path', { d: 'M14.5 7.5v1.5M14.5 11.25v1.5M14.5 15v1.5' }]],
};

function svgIcon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[name] || []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}

// kind drives the tint (meeting/chat/pr/review/mail); name the drawing.
function ico(kind, name = kind, small = false) {
  return el('span', { class: `ico ${kind}${small ? ' sm' : ''}` }, svgIcon(name));
}

// --- small builders -----------------------------------------------------------------

const note = (...parts) => el('div', { class: 'note' }, ...parts);

function linkBtn(text, onClick, cls = '') {
  const b = el('button', { class: `link-btn ${cls}`, type: 'button', text });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function button(text, onClick, primary = PRIMARY.has(text), small = false) {
  const b = el('button', { class: `btn${primary ? ' primary' : ''}${small ? ' small' : ''}`, type: 'button', text });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function row({ lead, title, sub, trail = [], onClick, tooltip, cls = '' }) {
  const r = el('div', { class: `row ${cls}`, role: 'link', tabindex: '0', title: tooltip },
    lead,
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title', text: title }),
      sub ? el('div', { class: 'row-sub', text: sub }) : null),
    ...trail);
  if (onClick) {
    r.addEventListener('click', onClick);
    r.addEventListener('keydown', (e) => e.key === 'Enter' && onClick());
  }
  return r;
}

const chip = (text, level = '') => el('span', { class: `chip ${level}`, text });

// "⚡ Review" etc.: hand the work to the AI agent chosen in Settings.
function agentBtn(label, req) {
  if (!agentName) return null;
  const b = button(`⚡ ${label}`, () => act({ type: 'handoff', ...req }), false, true);
  b.title = `Open ${agentName} in a terminal on this`;
  b.classList.add('agent');
  return b;
}
const smallBtn = (text, onClick, primary = false) => button(text, onClick, primary, true);
const jiraSite = (state) => state.jira?.site || null;

function keyChip(state, key) {
  const issue = (state?.jira?.issues || []).find((i) => i.key === key);
  const b = el('button', { class: 'key-chip', type: 'button', text: issue ? `${key} · ${issue.status}` : key,
    title: `${issue?.summary ? `${issue.summary}\n` : ''}Open ${key} (⇧-click: in Jira)` });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const site = jiraSite(state);
    if (e.shiftKey && site) act({ type: 'jira', raw: true, url: issue?.url || `https://${site}/browse/${key}` });
    else api.openItem(key);
  });
  return b;
}

// Due-date chip: overdue red, today orange, this week grey.
function dueChip(due) {
  if (!due) return null;
  const today = todayStr();
  if (due < today) return chip(`Overdue ${Math.round((new Date(today) - new Date(due)) / DAY)} d`, 'urgent');
  if (due === today) return chip('Due today', 'high');
  const days = Math.round((new Date(due) - new Date(today)) / DAY);
  if (days <= 6) return chip(`Due ${new Date(`${due}T12:00`).toLocaleDateString([], { weekday: 'short' })}`);
  return chip(`Due ${new Date(`${due}T12:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })}`);
}

// Jira-style status lozenge: colour from the status name, else its category.
function statusClass(t) {
  const name = t.status.toLowerCase();
  if (t.category === 'done') return 'done';
  if (/block|impediment|on hold|waiting/.test(name)) return 'blocked';
  if (/review/.test(name)) return 'review';
  if (/test|qa|valid|recette|uat|verif/.test(name)) return 'qa';
  return t.category === 'indeterminate' ? 'progress' : 'new';
}

const lozenge = (t) => el('span', { class: `lozenge ${statusClass(t)}`, text: t.status, title: `Status: ${t.status}` });

// Linked PR as a pill coloured by its state; opens the PR.
function prPill(p) {
  const b = el('button', { class: `pill small ${p.status}`, type: 'button', text: `#${p.number} ${MINE_LABEL[p.status] || ''}`.trim(), title: `${p.repo}#${p.number} · ${p.title}` });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    act({ type: 'pr', url: p.url });
  });
  return b;
}

// Why CI fails: GitHub Actions jobs show their error lines (+ log) and can be
// re-run; other checks (SonarQube…) only link out.
function ciDetails(p) {
  const box = el('div', { class: 'ci-details' });
  for (const c of p.failed || []) {
    const head = el('div', { class: 'ci-check' },
      el('span', { class: 'ci-name', text: `✗ ${c.name}` }),
      c.runId ? smallBtn('Re-run failed', () => act({ type: 'gh', kind: 'rerun', repo: p.repo, number: p.number, runId: c.runId })) : null,
      c.url ? linkBtn('Open', () => act({ type: 'pr', url: c.url })) : null);
    box.append(head);
    if (!c.runId) {
      box.append(el('div', { class: 'ci-note', text: 'External check: details on its own page.' }));
      continue;
    }
    const body = el('div', { class: 'ci-body', text: 'Loading the failure…' });
    box.append(body);
    const show = (d) => {
      if (!d || d.error) return body.replaceChildren(document.createTextNode(`Could not read the log: ${d?.error || 'unknown error'}`));
      if (d.expired) return body.replaceChildren(document.createTextNode('Logs are no longer available for this run.'));
      body.replaceChildren(...[
        d.errors.length ? el('ul', { class: 'ci-errors' }, ...d.errors.map((x) => el('li', { text: x }))) : null,
        d.text ? el('details', {}, el('summary', { text: `Log (${d.job})` }), el('pre', { text: d.text })) : null,
      ].filter(Boolean));
    };
    if (ciCache.has(c.runId)) show(ciCache.get(c.runId));
    else {
      api.ciDetails(p.repo, c.runId).then((d) => {
        ciCache.set(c.runId, d);
        show(d);
      });
    }
  }
  if (!(p.failed || []).length) box.append(el('div', { class: 'ci-note', text: 'No failing check details reported.' }));
  return box;
}
