// Home: today at a glance. Everything shown comes from the shell state pushed
// by the main process (priorities.js computes state.home).
// el, ago, waited, fmtTime: panels/common.js; act, row, chip…: panels/ui.js
const MAX_ROWS = 6;
const FOCUS_ROWS = 5;
const MINE_ORDER = ['ready', 'ci-failed', 'changes', 'conflict', 'ci-pending', 'waiting', 'draft'];
const TO_FIX = new Set(['ci-failed', 'changes', 'conflict']);
// Jira keys in PR titles ("[PROJ-123]") link PRs and tickets.
const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const PRIORITY_RANK = { highest: 0, blocker: 0, critical: 0, high: 1, medium: 2, low: 3, lowest: 4 };

let focusExpanded = false;
let lastState = null;

const openDetails = new Set(); // "repo#number" of PRs with CI details open

const daysSince = (ts) => Math.floor((Date.now() - new Date(ts).getTime()) / DAY);
const isRecent = (ts) => daysSince(ts) < 30;

// --- small builders -----------------------------------------------------------------

function section(id, count, children) {
  const card = $(id);
  card.querySelector('.count').textContent = count ?? '';
  card.querySelector('.body').replaceChildren(...children.flat(Infinity).filter(Boolean));
}

const scrollTo = (id) => $(id).scrollIntoView({ behavior: 'smooth', block: 'start' });
const waitLevel = (days) => (days > 5 ? 'urgent' : days > 2 ? 'high' : '');
const keysIn = (text) => [...new Set(text.match(KEY_RE) || [])];
// Keys of a PR: from its title, plus its branch ("feat/proj-123-…") when the
// key is one of my tickets (branches are often lower-case).
function prKeys(p, state = lastState) {
  const known = new Set((state?.jira?.issues || []).map((i) => i.key));
  const fromBranch = (String(p.branch || '').match(/[A-Za-z][A-Za-z0-9_]+-\d+/g) || []).map((k) => k.toUpperCase()).filter((k) => known.has(k));
  return [...new Set([...keysIn(p.title || ''), ...fromBranch])];
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
      next.meetUrl ? button('Join', () => act({ type: 'meet', url: next.meetUrl }), true) : '');
  } else {
    const slot = state.home?.slots?.[0];
    box.className = 'up-next free';
    box.replaceChildren(
      ico('meeting', 'free'),
      el('div', { class: 'grow' },
        el('div', { class: 'label', text: 'Calendar' }),
        el('div', { class: 'title', text: 'No more meetings today' }),
        slot ? el('div', { class: 'when', text: `Free until ${fmtTime(slot.end)}` }) : ''));
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

function ticketRow(state, t) {
  // My open PRs mentioning this ticket.
  const prs = (state.github?.mine || []).filter((p) => prKeys(p, state).includes(t.key));
  const sug = (state.jira?.suggestions || []).find((x) => x.key === t.key);
  const move = sug
    ? smallBtn(`→ ${sug.target.to}`, () => act({ type: 'jira-move', key: t.key, id: sug.target.id }), true)
    : null;
  if (move) move.title = sug.kind === 'next' ? `PR #${sug.pr.number} is merged` : `PR #${sug.pr.number} is open`;
  return row({
    lead: ico('ticket', 'ticket', true),
    title: t.summary,
    sub: [t.key, t.sprint?.name, t.type].filter(Boolean).join(' · '),
    trail: [
      move,
      ...prs.slice(0, 2).map(prPill),
      dueChip(t.due),
      lozenge(t),
      el('span', { class: `prio ${t.priority.toLowerCase()}`, title: `${t.priority || 'No'} priority` }),
      agentBtn('Implement', { kind: 'implement', key: t.key }),
    ],
    tooltip: `${t.key} · ${t.type}${t.priority ? ` · ${t.priority}` : ''}`,
    onClick: (e) => act({ type: 'jira', url: t.url, raw: !!e?.shiftKey }),
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

const GH_INSTALL = { darwin: 'brew install gh', win32: 'winget install GitHub.cli', linux: 'sudo apt install gh' };

function githubNote(gh) {
  if (gh.status === 'loading') return note('Loading…');
  if (gh.status === 'disabled') return note('Reviews are off. ', linkBtn('Turn them on in Settings', () => api.select('settings')), '.');
  if (gh.status === 'no-gh') return note('GitHub CLI not found: install it with ', el('code', { text: GH_INSTALL[api.platform] || GH_INSTALL.linux }), ', then run ', el('code', { text: 'gh auth login' }), '.');
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
      trail: [
        // Approved before, then re-requested (new commits since).
        r.approved ? chip('Re-review', '') : null,
        chip(days <= 0 ? 'today' : `${days} d waiting`, waitLevel(days)),
        r.approved ? null : smallBtn('Approve', () => act({ type: 'gh', kind: 'approve', repo: r.repo, number: r.number })),
        agentBtn('Review', { kind: 'review', repo: r.repo, number: r.number }),
      ],
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
  const id = `${p.repo}#${p.number}`;
  const failing = p.status === 'ci-failed';
  const trail = [
    ...prKeys(p).slice(0, 1).map((k) => keyChip(lastState, k)),
    p.status === 'ready' ? smallBtn('Merge', () => act({ type: 'gh', kind: 'merge', repo: p.repo, number: p.number }), true) : null,
    failing ? linkBtn(openDetails.has(id) ? 'Hide' : 'Why?', () => {
      if (openDetails.has(id)) openDetails.delete(id);
      else openDetails.add(id);
      renderMine(lastState);
    }) : null,
    failing ? agentBtn('Fix CI', { kind: 'fix-ci', repo: p.repo, number: p.number }) : null,
    el('span', { class: `pill ${p.status}`, text: MINE_LABEL[p.status] || p.status }),
  ];
  const r = row({
    lead: ico('pr', 'pr', true),
    title: p.title,
    sub: `${p.repo}#${p.number}${p.pendingReviewers ? ` · ${p.pendingReviewers} reviewer${p.pendingReviewers > 1 ? 's' : ''} pending` : ''} · updated ${ago(p.updatedAt)}`,
    trail,
    tooltip: p.url,
    onClick: () => act({ type: 'pr', url: p.url }),
  });
  return failing && openDetails.has(id) ? [r, ciDetails(p)] : [r];
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
    active.length ? active.flatMap(mineRow) : note('No active pull request.'),
    inactive.length
      ? el('details', { class: 'inactive' }, el('summary', { text: `Inactive for 30+ days (${inactive.length})` }), ...inactive.flatMap(mineRow))
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

// Messages: the latest notified Chat messages, one row per conversation
// (feed.js in main), then the other unread conversations from Chat's
// sidebar. ✕ / Clear all mark them read in Chat.
const MSG_LINES = 3;
const dismissing = new Set(); // conversation ids hidden until Chat confirms

function convLead(c, icon) {
  const fallback = () => (c?.kind === 'space'
    ? el('span', { class: 'ico sm hash', text: '#' })
    : ico(c?.kind === 'meeting' ? 'meeting' : 'chat', c ? convKind(c) : 'chat', true));
  if (!icon) return fallback();
  const img = el('img', { class: 'avatar sm', src: icon, alt: '' });
  img.addEventListener('error', () => img.replaceWith(fallback()));
  return img;
}

function dismissBtn(label, target) {
  const b = el('button', { class: 'dismiss', type: 'button', title: `${label} (marks it read in Chat)`, 'aria-label': label, text: '✕' });
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.closest('.msg')?.classList.add('gone');
    if (/^(dm|space)\//.test(target)) dismissing.add(target);
    const res = await api.feedDismiss(target);
    if (res?.failed) toast('Removed here, but Chat could not mark it read: open it in Chat', 'error');
  });
  return b;
}

function messageRow(state, items) {
  const latest = items[0];
  const conv = (state.chat?.conversations || []).find((c) => c.id === latest.group);
  const name = conv?.name || latest.title || 'Chat';
  // "Alertbot (Ops Alerts)" in the Ops Alerts row → "Alertbot".
  const senderOf = (m) => (m.title.endsWith(`(${name})`) ? m.title.slice(0, -name.length - 2).trim() : m.title);
  const lines = items.slice(0, MSG_LINES).map((m) => el('div', { class: 'msg-line' },
    m.title && m.title !== name ? el('strong', { text: `${senderOf(m)}: ` }) : null,
    document.createTextNode(m.body || '(no text)')));
  const r = el('div', { class: 'row msg', role: 'link', tabindex: '0', title: items.map((m) => `${m.title}: ${m.body}`).join('\n') },
    convLead(conv, latest.icon),
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title', text: name }),
      ...lines,
      items.length > MSG_LINES ? el('div', { class: 'msg-more', text: `+ ${items.length - MSG_LINES} earlier` }) : null),
    el('span', { class: 'side', text: ago(latest.at) }),
    items.length > 1 ? chip(String(items.length), 'urgent') : null,
    dismissBtn('Dismiss', latest.group || latest.id));
  const open = () => api.feedOpen(latest.id);
  r.addEventListener('click', open);
  r.addEventListener('keydown', (e) => e.key === 'Enter' && open());
  return r;
}

// Unread conversation with its last message (read from Chat's Home page).
function previewRow(c) {
  const p = c.preview;
  const r = el('div', { class: 'row msg', role: 'link', tabindex: '0', title: `${p.sender ? `${p.sender}: ` : ''}${p.text}` },
    convLead(c),
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title', text: c.name }),
      el('div', { class: 'msg-line' }, p.sender ? el('strong', { text: `${p.sender}: ` }) : null, document.createTextNode(p.text))),
    p.at ? el('span', { class: 'side', text: ago(p.at) }) : null,
    c.notifications ? chip(`${c.notifications}`, 'urgent') : null,
    dismissBtn('Mark read', c.id));
  const open = () => act({ type: 'chat', id: c.id });
  r.addEventListener('click', open);
  r.addEventListener('keydown', (e) => e.key === 'Enter' && open());
  return r;
}

function renderChat(state) {
  const convs = state.chat?.conversations || [];
  const unreadIds = new Set(convs.map((c) => c.id));
  for (const id of [...dismissing]) if (!unreadIds.has(id)) dismissing.delete(id);

  // Feed grouped by conversation, newest conversation first.
  const groups = new Map();
  for (const m of state.chat?.feed || []) {
    if (m.group && dismissing.has(m.group)) continue;
    const k = m.group || m.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const feedRows = [...groups.values()].slice(0, MAX_ROWS).map((items) => messageRow(state, items));

  // Unread conversations without a notified message (spaces, muted threads…).
  const others = convs.filter((c) => !groups.has(c.id) && !dismissing.has(c.id))
    .sort((a, b) => (CHAT_ORDER[a.kind] - CHAT_ORDER[b.kind]) || (b.notifications - a.notifications)
      || ((b.preview?.at || 0) - (a.preview?.at || 0)));
  const sub = (c) => ({ dm: 'Direct message', group: 'Group conversation', meeting: 'Meeting chat' }[c.kind]
    || (c.notifications ? 'Mention or followed thread' : 'New messages'));
  const otherRows = others.slice(0, MAX_ROWS).map((c) => {
    if (c.preview?.text) return previewRow(c);
    const r = row({
      lead: convLead(c),
      title: c.name,
      sub: sub(c),
      trail: [c.notifications ? chip(`${c.notifications}`, 'urgent') : null, dismissBtn('Mark read', c.id)],
      onClick: () => act({ type: 'chat', id: c.id }),
    });
    r.classList.add('msg');
    return r;
  });

  const total = groups.size + others.length;
  $('clear-all').hidden = !total;
  const extra = others.length - otherRows.length;
  section('chat', total || '', [
    feedRows,
    feedRows.length && otherRows.length ? el('div', { class: 'group-label', text: 'Other unread' }) : null,
    otherRows,
    total ? null : note('All caught up.'),
    extra > 0 ? linkBtn(`${extra} more →`, () => api.select('chat'), 'footer-link') : null,
  ]);
}

$('clear-all').addEventListener('click', async () => {
  for (const c of lastState?.chat?.conversations || []) dismissing.add(c.id);
  $('chat').querySelectorAll('.msg').forEach((n) => n.classList.add('gone'));
  const res = await api.feedDismiss('all');
  if (res?.failed) toast(`${res.failed} conversation${res.failed > 1 ? 's' : ''} could not be marked read in Chat`, 'error');
  else if (res?.ok) toast('All marked read', 'ok');
});

function renderMail(state) {
  const g = state.gmail || {};
  if (g.status === 'loading') return section('mail', '', [note('Loading…')]);
  if (g.status === 'auth') return section('mail', '', [note('Not signed in to Gmail. ', linkBtn('Open Mail', () => api.select('gmail')), '.')]);
  if (g.status === 'error') return section('mail', '', [note('Mail could not be loaded (offline?). ', linkBtn('Retry', () => api.refresh('gmail')))]);
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

// --- standup ---------------------------------------------------------------------

async function openStandup() {
  const modal = $('standup');
  const text = $('standup-text');
  modal.hidden = false;
  text.textContent = 'Preparing…';
  const res = await api.buildStandup();
  if (!res || res.error) {
    text.textContent = `Could not build the standup: ${res?.error || 'unknown error'}`;
    return;
  }
  text.textContent = res.text;
  $('standup-meta').textContent = res.partial ? 'Some sources were unavailable (GitHub or Jira): check before sending.' : '';
}

$('standup-btn').addEventListener('click', openStandup);
$('standup-close').addEventListener('click', () => { $('standup').hidden = true; });
$('standup-refresh').addEventListener('click', openStandup);
$('standup-copy').addEventListener('click', async () => {
  if (await api.copy($('standup-text').textContent)) toast('Standup copied', 'ok');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('standup').hidden = true;
});
api.onOpenStandup(openStandup);

api.agentStatus().then((st) => {
  agentName = st?.agent?.name || null;
  if (lastState) render(lastState);
});

api.onState(render);
api.getState().then(render);
