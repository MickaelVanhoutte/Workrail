// Home: today at a glance. Everything shown comes from the shell state pushed
// by the main process (priorities.js computes state.home).
// el, ago, waited, fmtTime: panels/common.js
const api = window.gslackShell;
const $ = (id) => document.getElementById(id);

const DAY = 86400000;
const MAX_ROWS = 6;
const FOCUS_ROWS = 5;
const PRIMARY = new Set(['Join', 'Merge']);
const MINE_ORDER = ['ready', 'ci-failed', 'changes', 'conflict', 'ci-pending', 'waiting', 'draft'];
const MINE_LABEL = {
  ready: 'Ready', 'ci-failed': 'CI failed', changes: 'Changes', conflict: 'Conflict',
  'ci-pending': 'CI running', waiting: 'In review', draft: 'Draft',
};
const TO_FIX = new Set(['ci-failed', 'changes', 'conflict']);
// Jira keys in PR titles ("[PROJ-123]") link PRs and tickets.
const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const PRIORITY_RANK = { highest: 0, blocker: 0, critical: 0, high: 1, medium: 2, low: 3, lowest: 4 };

let focusExpanded = false;
let lastState = null;

const act = (action) => api.action(action);
const daysSince = (ts) => Math.floor((Date.now() - new Date(ts).getTime()) / DAY);
const isRecent = (ts) => daysSince(ts) < 30;

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

function section(id, count, children) {
  const card = $(id);
  card.querySelector('.count').textContent = count ?? '';
  card.querySelector('.body').replaceChildren(...children.flat(Infinity).filter(Boolean));
}

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
const scrollTo = (id) => $(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
const waitLevel = (days) => (days > 5 ? 'urgent' : days > 2 ? 'high' : '');
const todayStr = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local
const keysIn = (text) => [...new Set(text.match(KEY_RE) || [])];
const jiraSite = (state) => state.jira?.site || null;

function keyChip(state, key) {
  const issue = (state.jira?.issues || []).find((i) => i.key === key);
  const site = jiraSite(state);
  if (!issue && !site) return null; // Jira not set up: no link to offer
  const b = el('button', { class: 'key-chip', type: 'button', text: issue ? `${key} · ${issue.status}` : key, title: issue?.summary || `Open ${key} in Jira` });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    act({ type: 'jira', url: issue?.url || `https://${site}/browse/${key}` });
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

function duration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h${mins % 60 ? ` ${String(mins % 60).padStart(2, '0')}` : ''}`;
}

function convKind(c) {
  return c.kind === 'dm' ? 'chat' : c.kind === 'group' ? 'group' : c.kind === 'meeting' ? 'meeting' : 'space';
}

// --- hero ---------------------------------------------------------------------------

function renderHero(state) {
  const h = new Date().getHours();
  const hello = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  $('greeting').textContent = state.user?.firstName ? `${hello}, ${state.user.firstName}` : hello;
  $('date').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  const box = $('up-next');
  const cal = state.calendar || {};
  if (cal.status !== 'ok') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const now = Date.now();
  const next = cal.next;
  const endOfDay = new Date().setHours(23, 59, 59, 999);
  let label;
  let when;
  let cls;
  if (next && next.ongoing) {
    label = 'Now';
    when = `until ${fmtTime(next.end)} · ${duration(next.end - now)} left`;
    cls = 'ongoing';
  } else if (next && next.start <= endOfDay) {
    const soon = next.start - now <= 15 * 60000;
    label = soon ? 'Starting soon' : 'Up next';
    when = `${fmtTime(next.start)}–${fmtTime(next.end)} · in ${duration(next.start - now)}`;
    cls = soon ? 'soon' : '';
  }
  if (label) {
    box.className = `up-next ${cls}`;
    box.replaceChildren(
      ico('meeting'),
      el('div', { class: 'grow' },
        el('div', { class: 'label', text: label }),
        el('div', { class: 'title', text: next.title, title: next.title }),
        el('div', { class: 'when', text: when })),
      next.meetUrl ? button('Join', () => act({ type: 'meet', url: next.meetUrl }), true) : null);
  } else {
    const slot = state.home?.slots?.[0];
    box.className = 'up-next free';
    box.replaceChildren(
      ico('meeting', 'free'),
      el('div', { class: 'grow' },
        el('div', { class: 'label', text: 'Calendar' }),
        el('div', { class: 'title', text: 'No more meetings today' }),
        slot ? el('div', { class: 'when', text: `Free until ${fmtTime(slot.end)}` }) : null));
  }
}

// --- stats ---------------------------------------------------------------------------

function stat({ key, value, detail, level = '', onClick }) {
  const b = el('button', { class: `stat ${level}`, type: 'button' },
    el('span', { class: 'k', text: key }),
    el('span', { class: 'v', text: String(value) }),
    el('span', { class: 'd', text: detail, title: detail }));
  b.addEventListener('click', onClick);
  return b;
}

function renderStats(state) {
  const now = Date.now();
  const cal = state.calendar || {};
  const gh = state.github || {};
  const tiles = [];

  if (cal.status === 'ok') {
    const endOfDay = new Date().setHours(23, 59, 59, 999);
    const left = (cal.today || []).filter((m) => m.end > now && m.start <= endOfDay);
    const next = left.find((m) => m.start > now);
    const ongoing = left.find((m) => m.start <= now);
    tiles.push(stat({
      key: 'Meetings left',
      value: left.length,
      detail: ongoing ? `Now: ${ongoing.title}` : next ? `Next ${fmtTime(next.start)} · ${next.title}` : 'Done for today',
      level: ongoing ? 'ok' : next && next.start - now <= 15 * 60000 ? 'high' : '',
      onClick: () => scrollTo('today'),
    }));
  } else {
    tiles.push(stat({ key: 'Meetings', value: '—', detail: 'Connect your calendar', onClick: () => api.select('settings') }));
  }

  const people = (gh.reviews || []).filter((r) => !r.bot && !r.draft);
  const oldest = people.reduce((max, r) => Math.max(max, daysSince(r.requestedAt)), 0);
  tiles.push(stat({
    key: 'Reviews to do',
    value: gh.status === 'ok' ? people.length : '—',
    detail: gh.status !== 'ok' ? 'GitHub unavailable' : people.length ? `Oldest waiting ${oldest} d` : 'All clear',
    level: people.length ? waitLevel(oldest) : 'ok',
    onClick: () => scrollTo('reviews'),
  }));

  const active = (gh.mine || []).filter((p) => isRecent(p.updatedAt));
  const fix = active.filter((p) => TO_FIX.has(p.status));
  const ready = active.filter((p) => p.status === 'ready');
  const parts = [];
  const failed = fix.filter((p) => p.status === 'ci-failed').length;
  if (failed) parts.push(`${failed} CI failed`);
  if (fix.length - failed) parts.push(`${fix.length - failed} to update`);
  if (ready.length) parts.push(`${ready.length} ready to merge`);
  tiles.push(stat({
    key: 'My PRs to act on',
    value: gh.status === 'ok' ? fix.length + ready.length : '—',
    detail: parts.join(' · ') || `${active.length} in review`,
    level: fix.length ? 'urgent' : ready.length ? 'ok' : '',
    onClick: () => scrollTo('mine'),
  }));

  const jira = state.jira || {};
  const issues = jira.issues || [];
  const today = todayStr();
  const late = issues.filter((i) => i.due && i.due < today).length;
  const dueToday = issues.filter((i) => i.due === today).length;
  const doing = issues.filter((i) => i.category === 'indeterminate').length;
  const tparts = [];
  if (late) tparts.push(`${late} overdue`);
  if (dueToday) tparts.push(`${dueToday} due today`);
  tparts.push(`${doing} in progress`);
  tiles.push(stat({
    key: 'My tickets',
    value: jira.status === 'ok' ? issues.length : '—',
    detail: jira.status === 'ok' ? tparts.join(' · ') : ({ auth: 'Sign in to Jira', disabled: 'Jira is off', unconfigured: 'Set up Jira' }[jira.status] || 'Loading…'),
    level: late ? 'urgent' : dueToday ? 'high' : '',
    onClick: () => (jira.status === 'auth' ? api.select('jira') : jira.status === 'unconfigured' ? api.select('settings') : scrollTo('tickets')),
  }));

  const convs = state.chat?.conversations || [];
  const direct = convs.filter((c) => c.kind === 'dm' || c.kind === 'group').length;
  const spaces = convs.length - direct;
  tiles.push(stat({
    key: 'Direct messages',
    value: direct,
    detail: spaces ? `${spaces} other unread conversation${spaces > 1 ? 's' : ''}` : 'All caught up',
    level: direct ? 'urgent' : '',
    onClick: () => scrollTo('chat'),
  }));

  const important = state.gmail?.important;
  const inbox = state.badges?.gmail || 0;
  tiles.push(stat({
    key: 'Important mail',
    value: important ? important.length : '—',
    detail: `${inbox.toLocaleString()} unread in inbox`,
    level: important?.length ? 'high' : '',
    onClick: () => scrollTo('mail'),
  }));

  $('stats').replaceChildren(...tiles);
}

// --- Focus ------------------------------------------------------------------------------

function focusLead(a) {
  if (a.kind === 'ticket') return ico('ticket');
  if (a.kind !== 'chat') return ico(a.kind);
  if (a.tag === 'Group') return ico('chat', 'group');
  if (a.action.id?.startsWith('space/')) return el('span', { class: 'ico hash', text: '#' });
  return ico('chat');
}

function focusRow(a) {
  const lead = focusLead(a);
  const tagLevel = a.kind === 'meeting' ? (a.tag === 'Now' ? 'ok' : 'high') : a.level === 'urgent' ? 'urgent' : a.level === 'high' ? 'high' : '';
  return row({
    cls: a.level,
    lead,
    title: a.title,
    sub: a.detail,
    tooltip: `Why: ${a.reason}`,
    trail: [chip(a.tag, tagLevel), button(a.button, () => act(a.action))],
    onClick: () => act(a.action),
  });
}

function renderFocus(state) {
  const all = state.home?.actions || [];
  const shown = focusExpanded ? all : all.slice(0, FOCUS_ROWS);
  const rest = all.length - shown.length;

  const slot = state.home?.slots?.[0];
  const reviews = (state.github?.reviews || []).filter((r) => !r.bot && !r.draft).length;
  const hint = slot && reviews
    ? el('div', { class: 'slot-hint' }, svgIcon('free'),
      document.createTextNode(`Free ${fmtTime(slot.start)}–${fmtTime(slot.end)} (${duration(slot.end - slot.start)}) · a good moment for ${reviews === 1 ? 'your review' : `your ${reviews} reviews`}`))
    : null;

  const toggle = all.length > FOCUS_ROWS
    ? linkBtn(focusExpanded ? 'Show less' : `Show ${rest} more`, () => {
      focusExpanded = !focusExpanded;
      renderFocus(lastState);
    }, 'footer-link')
    : null;

  section('focus', all.length ? `${all.length} item${all.length > 1 ? 's' : ''}` : '',
    shown.length ? [shown.map(focusRow), toggle, hint] : [note('Nothing needs you right now 🎉'), hint]);
}

// --- Jira tickets ---------------------------------------------------------------------------

function ticketSort(a, b) {
  const today = todayStr();
  const urgency = (t) => (t.due && t.due <= today ? 0 : 1);
  return urgency(a) - urgency(b)
    || (a.due || '9999').localeCompare(b.due || '9999')
    || (PRIORITY_RANK[a.priority.toLowerCase()] ?? 5) - (PRIORITY_RANK[b.priority.toLowerCase()] ?? 5)
    || new Date(b.updated) - new Date(a.updated);
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

function ticketRow(state, t) {
  // My open PRs mentioning this ticket.
  const prs = (state.github?.mine || []).filter((p) => keysIn(p.title).includes(t.key));
  return row({
    lead: ico('ticket', 'ticket', true),
    title: t.summary,
    sub: [t.key, t.sprint?.name, t.type].filter(Boolean).join(' · '),
    trail: [
      ...prs.slice(0, 2).map(prPill),
      dueChip(t.due),
      lozenge(t),
      el('span', { class: `prio ${t.priority.toLowerCase()}`, title: `${t.priority || 'No'} priority` }),
    ],
    tooltip: `${t.key} · ${t.type}${t.priority ? ` · ${t.priority}` : ''}`,
    onClick: () => act({ type: 'jira', url: t.url }),
  });
}

function renderTickets(state) {
  const jira = state.jira || {};
  if (jira.status === 'loading') return section('tickets', '', [note('Loading…')]);
  if (jira.status === 'disabled') return section('tickets', '', [note('Jira is off. ', linkBtn('Turn it on in Settings', () => api.select('settings')), '.')]);
  if (jira.status === 'unconfigured') return section('tickets', '', [note('Set your Jira site (yourcompany.atlassian.net) to see your tickets here. ', linkBtn('Open Settings', () => api.select('settings')), '.')]);
  if (jira.status === 'auth') {
    return section('tickets', '', [note('Sign in to Jira once in the app to see your tickets here. ',
      linkBtn('Open Jira', () => api.select('jira')), '.')]);
  }
  if (jira.status !== 'ok') return section('tickets', '', [note(`Could not load Jira: ${jira.error || 'unknown error'}. `, linkBtn('Retry', () => api.refresh('jira')))]);

  const issues = [...(jira.issues || [])].sort(ticketSort);
  const groups = [
    ['In progress', issues.filter((i) => i.category === 'indeterminate')],
    ['To do', issues.filter((i) => i.category !== 'indeterminate')],
  ].filter(([, list]) => list.length);
  const nodes = [];
  let hidden = 0;
  for (const [label, list] of groups) {
    nodes.push(el('div', { class: 'group-label', text: `${label} · ${list.length}` }));
    nodes.push(list.slice(0, MAX_ROWS).map((t) => ticketRow(state, t)));
    hidden += Math.max(0, list.length - MAX_ROWS);
  }
  section('tickets', issues.length || '', [
    issues.length ? nodes : note(jira.custom ? 'No ticket matches your filter.' : 'No open ticket assigned to you 🎉'),
    hidden ? linkBtn(`${hidden} more in Jira →`, () => api.select('jira'), 'footer-link') : null,
  ]);
}

// --- GitHub sections ------------------------------------------------------------------------

function githubNote(gh) {
  if (gh.status === 'loading') return note('Loading…');
  if (gh.status === 'disabled') return note('Reviews are off. ', linkBtn('Turn them on in Settings', () => api.select('settings')), '.');
  if (gh.status === 'no-gh') return note('GitHub CLI not found: install it with ', el('code', { text: 'brew install gh' }), ', then run ', el('code', { text: 'gh auth login' }), '.');
  if (gh.status === 'auth') return note('Not signed in to GitHub: run ', el('code', { text: 'gh auth login' }), ' in a terminal.');
  return note(`Could not load GitHub: ${gh.error || 'unknown error'}`);
}

function renderReviews(state) {
  const gh = state.github || {};
  if (gh.status !== 'ok') return section('reviews', '', [githubNote(gh)]);
  const people = (gh.reviews || [])
    .filter((r) => !r.bot && !r.draft)
    .sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt));
  const bots = (gh.reviews || []).filter((r) => r.bot).length;
  const rows = people.slice(0, MAX_ROWS).map((r) => {
    const days = daysSince(r.requestedAt);
    return row({
      lead: r.avatar ? el('img', { class: 'avatar', src: `${r.avatar}${r.avatar.includes('?') ? '&' : '?'}s=64`, alt: '' }) : ico('review'),
      title: r.title,
      sub: `${r.repo}#${r.number} · ${r.author}`,
      trail: [chip(days <= 0 ? 'today' : `${days} d waiting`, waitLevel(days))],
      tooltip: r.url,
      onClick: () => act({ type: 'pr', url: r.url }),
    });
  });
  const extra = people.length - rows.length;
  const footer = [];
  if (extra > 0) footer.push(`${extra} more`);
  if (bots) footer.push(`${bots} from bots`);
  section('reviews', people.length || '', [
    rows.length ? rows : note('No review waiting from people 🎉'),
    footer.length ? linkBtn(`${footer.join(' · ')} →`, () => api.select('github'), 'footer-link') : null,
  ]);
}

function mineRow(p) {
  return row({
    lead: ico('pr', 'pr', true),
    title: p.title,
    sub: `${p.repo}#${p.number}${p.pendingReviewers ? ` · ${p.pendingReviewers} reviewer${p.pendingReviewers > 1 ? 's' : ''} pending` : ''} · updated ${ago(p.updatedAt)}`,
    trail: [...keysIn(p.title).slice(0, 1).map((k) => keyChip(lastState, k)), el('span', { class: `pill ${p.status}`, text: MINE_LABEL[p.status] || p.status })],
    tooltip: p.url,
    onClick: () => act({ type: 'pr', url: p.url }),
  });
}

function renderMine(state) {
  const gh = state.github || {};
  if (gh.status !== 'ok') return section('mine', '', [githubNote(gh)]);
  const byStatus = (a, b) => MINE_ORDER.indexOf(a.status) - MINE_ORDER.indexOf(b.status);
  const all = gh.mine || [];
  const active = all.filter((p) => isRecent(p.updatedAt)).sort(byStatus);
  // Abandoned PRs (no activity for 30 days) are folded away.
  const inactive = all.filter((p) => !isRecent(p.updatedAt)).sort(byStatus);
  section('mine', active.length || '', [
    active.length ? active.map(mineRow) : note('No active pull request.'),
    inactive.length
      ? el('details', { class: 'inactive' }, el('summary', { text: `Inactive for 30+ days (${inactive.length})` }), ...inactive.map(mineRow))
      : null,
  ]);
}

// --- Today --------------------------------------------------------------------------------

function renderToday(state) {
  const cal = state.calendar || {};
  if (cal.status === 'unconfigured') {
    return section('today', '', [note('Connect your calendar to see your day and get meeting reminders. ',
      linkBtn('Open Settings', () => api.select('settings')), '.')]);
  }
  if (cal.status === 'error') {
    return section('today', '', [note('The calendar could not be loaded. ', linkBtn('Check Settings', () => api.select('settings')), '.')]);
  }
  const now = Date.now();
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const dayEnd = new Date().setHours(23, 59, 59, 999);
  const meetings = (cal.today || []).filter((m) => m.start <= dayEnd && m.end > dayStart);
  const items = [
    ...meetings.map((m) => ({ ...m, type: 'meeting' })),
    ...(state.home?.slots || []).map((s) => ({ ...s, type: 'free' })),
  ].sort((a, b) => a.start - b.start);

  const nodes = [];
  let nowPlaced = false;
  const nowLine = () => el('div', { class: 'now-line' }, el('span', { text: fmtTime(now) }));
  for (const it of items) {
    if (!nowPlaced && it.start > now) {
      nodes.push(nowLine());
      nowPlaced = true;
    }
    if (it.type === 'free') {
      nodes.push(el('div', { class: 'ev free' },
        el('span', { class: 't', text: fmtTime(it.start) }),
        el('div', { class: 'row-main' }, el('div', { class: 'row-title', text: `Free · ${duration(it.end - it.start)}` }))));
      continue;
    }
    const past = it.end <= now;
    const ongoing = it.start <= now && now < it.end;
    if (ongoing) nowPlaced = true;
    const joinable = it.meetUrl && !past && (ongoing || it.start - now < 60 * 60000);
    nodes.push(el('div', { class: `ev ${past ? 'past' : ongoing ? 'ongoing' : ''}` },
      el('span', { class: 't', text: fmtTime(it.start) }),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title', text: it.title, title: it.title }),
        el('div', { class: 'row-sub', text: `${fmtTime(it.start)}–${fmtTime(it.end)}${ongoing ? ' · now' : ''}` })),
      joinable ? button('Join', () => act({ type: 'meet', url: it.meetUrl }), ongoing || it.start - now < 15 * 60000, true) : null));
  }
  if (!nowPlaced && items.length) nodes.push(nowLine());

  const left = meetings.filter((m) => m.end > now).length;
  section('today', meetings.length ? `${left} left` : '', nodes.length
    ? [el('div', { class: 'timeline' }, ...nodes)]
    : [note('No meetings today.')]);
}

// --- Chat & Mail -----------------------------------------------------------------------------

const CHAT_ORDER = { dm: 0, group: 1, space: 2, meeting: 3 };

function renderChat(state) {
  const convs = [...(state.chat?.conversations || [])].sort((a, b) =>
    (CHAT_ORDER[a.kind] - CHAT_ORDER[b.kind]) || (b.notifications - a.notifications));
  const sub = (c) => ({ dm: 'Direct message', group: 'Group conversation', meeting: 'Meeting chat' }[c.kind]
    || (c.notifications ? 'Mention or followed thread' : 'New messages'));
  const lead = (c) => (c.kind === 'space'
    ? el('span', { class: 'ico sm hash', text: '#' })
    : ico(c.kind === 'meeting' ? 'meeting' : 'chat', convKind(c), true));
  const rows = convs.slice(0, MAX_ROWS).map((c) => row({
    lead: lead(c),
    title: c.name,
    sub: sub(c),
    trail: c.notifications ? [chip(`${c.notifications}`, 'urgent')] : c.kind === 'dm' || c.kind === 'group' ? [chip('new', 'urgent')] : [],
    onClick: () => act({ type: 'chat', id: c.id }),
  }));
  const extra = convs.length - rows.length;
  section('chat', convs.length || '', [
    rows.length ? rows : note('All caught up.'),
    extra > 0 ? linkBtn(`${extra} more →`, () => api.select('chat'), 'footer-link') : null,
  ]);
}

function renderMail(state) {
  const g = state.gmail || {};
  if (g.status === 'loading') return section('mail', '', [note('Loading…')]);
  if (g.important === null) return section('mail', '', [note('Important mail is not available for this account.')]);
  const mails = [...g.important].sort((a, b) => b.at - a.at);
  const rows = mails.slice(0, MAX_ROWS).map((m) => row({
    lead: ico('mail', 'mail', true),
    title: m.from || m.subject,
    sub: m.subject,
    trail: [el('span', { class: 'side', text: ago(m.at) })],
    tooltip: m.snippet,
    onClick: () => act({ type: 'mail', url: m.url }),
  }));
  const extra = mails.length - rows.length;
  section('mail', mails.length || '', [
    rows.length ? rows : note('No new important mail since your last workday.'),
    extra > 0 ? linkBtn(`${extra} more →`, () => api.select('gmail'), 'footer-link') : null,
  ]);
}

// --- wiring -----------------------------------------------------------------------------------

function render(state) {
  if (!state) return;
  lastState = state;
  renderHero(state);
  renderStats(state);
  renderFocus(state);
  renderTickets(state);
  renderReviews(state);
  renderMine(state);
  renderToday(state);
  renderChat(state);
  renderMail(state);
}

for (const a of document.querySelectorAll('.see-all')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    api.select(a.dataset.view);
  });
}

api.onState(render);
api.getState().then(render);
