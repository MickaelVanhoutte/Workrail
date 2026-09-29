// Work item hub: one issue key at a time (location.hash = "#PROJ-123", so
// Back / Forward work). Data comes from main (item:load): the Jira ticket,
// pull requests with CI, Chat mentions, mail and meetings naming the key.
// el, ago, fmtTime: panels/common.js; act, row, chip, ciDetails…: panels/ui.js
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;
const RECENT_STORE = 'workrail.recentItems';
const REFRESH_MS = 60 * 1000;

let lastState = null;
let current = null; // key shown
let data = null; // item:load result for `current`
let loadSeq = 0;
const openDetails = new Set(); // "repo#number" with CI details open
let descExpanded = false;

function section(id, count, children) {
  const card = $(id);
  const c = card.querySelector('.count');
  if (c) c.textContent = count ?? '';
  card.querySelector('.body').replaceChildren(...children.flat(Infinity).filter(Boolean));
}

const jiraSiteOf = () => lastState?.jira?.site || null;
const jiraUrl = (key) => (jiraSiteOf() ? `https://${jiraSiteOf()}/browse/${key}` : null);

// --- recent items (per-viewer convenience only) ---------------------------------------

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_STORE) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.key === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(key, summary) {
  const list = [{ key, summary: summary || '', at: Date.now() }, ...readRecent().filter((x) => x.key !== key)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_STORE, JSON.stringify(list));
  } catch {
    // storage unavailable: no history, nothing else changes
  }
}

// --- navigation ----------------------------------------------------------------------

const normalize = (k) => String(k || '').trim().toUpperCase();

function go(key) {
  key = normalize(key);
  if (!KEY_RE.test(key)) return;
  if (location.hash === `#${key}`) load(key, true);
  else location.hash = key;
}

function fromHash() {
  const key = normalize(decodeURIComponent(location.hash.slice(1)));
  if (KEY_RE.test(key)) load(key);
  else showStart();
  $('back').disabled = history.length <= 1;
}

function showStart() {
  current = null;
  data = null;
  $('item').hidden = true;
  $('start').hidden = false;
  renderStart();
}

async function load(key, force = false) {
  const changed = key !== current;
  current = key;
  if (changed) {
    data = null;
    descExpanded = false;
    openDetails.clear();
    $('start').hidden = true;
    $('item').hidden = false;
    $('scroller').scrollTop = 0;
    renderLoading(key);
  }
  const seq = ++loadSeq;
  const res = await api.loadItem(key, { force });
  if (seq !== loadSeq || key !== current) return;
  if (!res || res.error) {
    if (!data) {
      renderLoading(key);
      section('prs', '', [note(`Could not load ${key}: ${res?.error || 'unknown error'}. `, linkBtn('Retry', () => load(key, true)))]);
    } else toast(res?.error || 'Refresh failed', 'error');
    return;
  }
  data = res;
  pushRecent(key, res.jira.issue?.summary);
  render();
}

// --- start page ------------------------------------------------------------------------

function ticketLine(t, sub) {
  return row({
    lead: ico('ticket', 'ticket', true),
    title: t.summary || t.key,
    sub: sub ?? [t.key, t.status].filter(Boolean).join(' · '),
    trail: [t.status ? lozenge(t) : null],
    onClick: () => go(t.key),
  });
}

function renderStart() {
  const recent = readRecent();
  section('recent', '', recent.length
    ? recent.map((r) => row({ lead: ico('ticket', 'ticket', true), title: r.summary || r.key, sub: `${r.key} · opened ${ago(r.at)}`, onClick: () => go(r.key) }))
    : [note('Items you open show up here. Try ⌘J / Ctrl+J from anywhere.')]);
  const jira = lastState?.jira || {};
  const mine = jira.issues || [];
  section('mine-list', mine.length || '', jira.status === 'ok'
    ? (mine.length ? mine.slice(0, 15).map((t) => ticketLine(t)) : [note('No open ticket assigned to you.')])
    : [note(jira.status === 'auth' ? 'Sign in to Jira to list your tickets. ' : 'Jira is not connected. ',
      linkBtn(jira.status === 'auth' ? 'Open Jira' : 'Open Settings', () => api.select(jira.status === 'auth' ? 'jira' : 'settings')))]);
}

// --- finder (⌘J) ------------------------------------------------------------------------

let finderSel = 0;
let finderItems = [];
let finderOpen = false; // focused: results shown

function finderResults(q) {
  const text = q.trim();
  if (!text) return readRecent().slice(0, 6).map((r) => ({ key: r.key, label: r.summary || r.key, hint: 'Recent' }));
  const out = [];
  const asKey = normalize(text);
  if (KEY_RE.test(asKey)) out.push({ key: asKey, label: `Open ${asKey}`, hint: 'Go' });
  const needle = text.toLowerCase();
  const pool = [...(lastState?.jira?.issues || []), ...readRecent()];
  const seen = new Set(out.map((x) => x.key));
  for (const t of pool) {
    if (seen.has(t.key)) continue;
    if (t.key.toLowerCase().includes(needle) || String(t.summary || '').toLowerCase().includes(needle)) {
      seen.add(t.key);
      out.push({ key: t.key, label: t.summary || t.key, hint: t.key });
    }
    if (out.length >= 8) break;
  }
  return out;
}

function renderFinder() {
  const box = $('find-results');
  finderItems = finderResults($('find').value);
  finderSel = Math.min(finderSel, Math.max(0, finderItems.length - 1));
  box.hidden = !finderItems.length || !finderOpen;
  box.replaceChildren(...finderItems.map((it, i) => {
    const opt = el('div', { class: `finder-opt${i === finderSel ? ' sel' : ''}`, role: 'option' },
      el('span', { class: 'label', text: it.label }), el('span', { class: 'hint', text: it.hint }));
    opt.addEventListener('mousedown', (e) => {
      e.preventDefault();
      pick(it);
    });
    return opt;
  }));
}

function pick(it) {
  finderOpen = false;
  $('find').value = '';
  $('find').blur();
  $('find-results').hidden = true;
  go(it.key);
}

function focusFinder() {
  $('find').focus();
  $('find').select();
  renderFinder();
}

$('find').addEventListener('input', () => {
  finderSel = 0;
  finderOpen = true;
  renderFinder();
});
$('find').addEventListener('focus', () => {
  finderOpen = true;
  renderFinder();
});
$('find').addEventListener('blur', () => {
  finderOpen = false;
  $('find-results').hidden = true;
});
$('find').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    finderSel = (finderSel + (e.key === 'ArrowDown' ? 1 : -1) + finderItems.length) % Math.max(1, finderItems.length);
    renderFinder();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (finderItems[finderSel]) pick(finderItems[finderSel]);
  } else if (e.key === 'Escape') {
    $('find').blur();
  }
});
$('back').addEventListener('click', () => history.back());

// --- hero -------------------------------------------------------------------------------

function renderLoading(key) {
  $('item-top').replaceChildren(ico('ticket', 'ticket', true), el('span', { class: 'item-key', text: key }));
  $('item-title').textContent = key;
  $('item-meta').replaceChildren(el('span', { class: 'muted', text: 'Loading…' }));
  $('item-actions').replaceChildren();
  for (const id of ['prs', 'desc', 'related', 'comments', 'activity', 'chat', 'mail', 'meetings']) {
    $(id).hidden = false;
    section(id, '', [note('Loading…')]);
  }
}

function jiraNote(j) {
  if (j.status === 'auth') return note('Sign in to Jira to see this ticket. ', linkBtn('Open Jira', () => api.select('jira')), '.');
  if (j.status === 'off') return note('Jira is not connected: only GitHub, Chat, mail and meetings are shown. ', linkBtn('Settings', () => api.select('settings')), '.');
  if (/HTTP 404/.test(j.error || '')) return note('Jira does not know this ticket (or you cannot see it).');
  return note(`Could not load the ticket: ${j.error || 'unknown error'}. `, linkBtn('Retry', () => load(current, true)));
}

async function moveTo(t) {
  const res = await api.jiraTransition(current, t.id);
  report(res, `Moved to ${t.to}`);
  if (res?.ok) load(current, true);
}

function renderHero() {
  const key = current;
  const issue = data.jira.issue;
  $('item-top').replaceChildren(...[
    ico('ticket', 'ticket', true),
    el('span', { class: 'item-key', text: key }),
    issue?.type ? el('span', { class: 'muted', text: issue.type }) : null,
    issue?.parent ? linkBtn(`in ${issue.parent.key}`, () => go(issue.parent.key)) : null,
  ].filter(Boolean));
  $('item-title').textContent = issue?.summary || key;

  const meta = [];
  if (issue) {
    meta.push(lozenge(issue));
    if (issue.priority) meta.push(el('span', { class: 'meta-item' }, el('span', { class: `prio ${issue.priority.toLowerCase()}` }), document.createTextNode(issue.priority)));
    meta.push(el('span', { class: 'meta-item', text: issue.assignee ? `Assignee: ${issue.assignee}` : 'Unassigned' }));
    if (issue.sprint) meta.push(el('span', { class: 'meta-item', text: issue.sprint.name }));
    meta.push(dueChip(issue.due));
    if (issue.updated) meta.push(el('span', { class: 'meta-item muted', text: `updated ${ago(issue.updated)}` }));
  } else {
    meta.push(jiraNote(data.jira));
  }
  $('item-meta').replaceChildren(...meta.filter(Boolean));

  const actions = [];
  const sug = (lastState?.jira?.suggestions || []).find((x) => x.key === key);
  if (sug) {
    const b = button(`→ ${sug.target.to}`, () => moveTo(sug.target), true, true);
    b.title = sug.kind === 'next' ? `PR #${sug.pr.number} is merged` : `PR #${sug.pr.number} is open`;
    actions.push(b);
  }
  const moves = (data.jira.transitions || []).filter((t) => !sug || String(t.id) !== String(sug.target.id));
  if (issue && moves.length) {
    const sel = el('select', { class: 'move', 'aria-label': 'Move ticket' },
      el('option', { value: '', text: 'Move to…' }),
      ...moves.map((t) => el('option', { value: String(t.id), text: t.to })));
    sel.addEventListener('change', () => {
      const t = moves.find((x) => String(x.id) === sel.value);
      sel.value = '';
      if (t) moveTo(t);
    });
    actions.push(sel);
  }
  if (issue) actions.push(agentBtn('Implement', { kind: 'implement', key }));
  if (jiraUrl(key)) actions.push(smallBtn('Open in Jira', () => act({ type: 'jira', raw: true, url: jiraUrl(key) })));
  const branch = `feat/${slugOf(key, issue?.summary)}`;
  const copyBranch = smallBtn('Copy branch', async () => (await api.copy(branch)) && toast(`Copied ${branch}`, 'ok'));
  copyBranch.title = branch;
  actions.push(copyBranch);
  if (jiraUrl(key)) {
    actions.push(smallBtn('Copy link', async () => (await api.copy(`${key} ${issue?.summary || ''}\n${jiraUrl(key)}`.replace(/ \n/, '\n'))) && toast('Link copied', 'ok')));
  }
  const refresh = smallBtn('↻', () => load(key, true));
  refresh.title = `Refresh (loaded ${ago(data.loadedAt)})`;
  actions.push(refresh);
  $('item-actions').replaceChildren(...actions.filter(Boolean));
}

// Same slug as main (keys.branchSlug) for "Copy branch".
const slugOf = (key, summary = '') => [key.toLowerCase(), String(summary).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')].filter(Boolean).join('-');

// --- pull requests -----------------------------------------------------------------------

const stateOf = (p) => p.state || (p.mergedAt ? 'MERGED' : 'OPEN');

function isMine(p) {
  if (typeof p.mine === 'boolean') return p.mine;
  return (lastState?.github?.mine || []).some((m) => m.repo === p.repo && m.number === p.number);
}

function prStatePill(p) {
  const st = stateOf(p);
  if (st === 'MERGED') return el('span', { class: 'pill merged', text: 'Merged' });
  if (st === 'CLOSED') return el('span', { class: 'pill closed', text: 'Closed' });
  const status = p.draft ? 'draft' : p.status || 'waiting';
  return el('span', { class: `pill ${status}`, text: MINE_LABEL[status] || status });
}

function prRow(p) {
  const id = `${p.repo}#${p.number}`;
  const open = stateOf(p) === 'OPEN';
  const mine = isMine(p);
  const failing = open && p.status === 'ci-failed';
  const trail = [
    open && !mine && !p.draft && !p.approved ? smallBtn('Approve', () => act({ type: 'gh', kind: 'approve', repo: p.repo, number: p.number }).then(() => load(current, true))) : null,
    open && mine && p.status === 'ready' ? smallBtn('Merge', () => act({ type: 'gh', kind: 'merge', repo: p.repo, number: p.number }).then(() => load(current, true)), true) : null,
    failing && (p.failed || []).length ? linkBtn(openDetails.has(id) ? 'Hide' : 'Why?', () => {
      if (openDetails.has(id)) openDetails.delete(id);
      else openDetails.add(id);
      renderPRs();
    }) : null,
    failing ? agentBtn('Fix CI', { kind: 'fix-ci', repo: p.repo, number: p.number }) : null,
    open && !mine ? agentBtn('Review', { kind: 'review', repo: p.repo, number: p.number }) : null,
    p.approved ? chip('Approved', 'ok') : null,
    prStatePill(p),
  ];
  const who = p.author ? (mine ? 'you' : p.author) : mine ? 'you' : null;
  const when = stateOf(p) === 'MERGED' && p.mergedAt ? `merged ${ago(p.mergedAt)}` : p.updatedAt ? `updated ${ago(p.updatedAt)}` : '';
  const r = row({
    lead: p.avatar ? el('img', { class: 'avatar', src: `${p.avatar}${p.avatar.includes('?') ? '&' : '?'}s=64`, alt: '' }) : ico('pr', 'pr', true),
    title: p.title,
    sub: [id, who && `by ${who}`, when].filter(Boolean).join(' · '),
    trail,
    tooltip: p.url,
    cls: open ? '' : 'done',
    onClick: () => act({ type: 'pr', url: p.url }),
  });
  return failing && openDetails.has(id) ? [r, ciDetails(p)] : [r];
}

function renderPRs() {
  const g = data.github;
  const prs = g.prs || [];
  const nodes = prs.flatMap(prRow);
  if (g.status === 'no-gh') nodes.push(note('GitHub CLI not found: install it, then run ', el('code', { text: 'gh auth login' }), '.'));
  else if (g.status === 'auth') nodes.push(note('Not signed in to GitHub: run ', el('code', { text: 'gh auth login' }), ' in a terminal.'));
  else if (g.status === 'off') nodes.push(note('GitHub is off in Settings.'));
  else if (g.status === 'error' || g.partial) nodes.push(note(`GitHub search failed${g.error ? `: ${g.error.split('\n')[0]}` : ''}. `, linkBtn('Retry', () => load(current, true))));
  else if (!prs.length) nodes.push(note(`No pull request mentions ${current} yet (title, branch or description).`));
  section('prs', prs.length || '', nodes);
}

// --- Jira details --------------------------------------------------------------------------

function renderDesc() {
  const issue = data.jira.issue;
  if (!issue) return section('desc', '', [jiraNote(data.jira)]);
  const text = issue.description || '';
  if (!text) return section('desc', '', [note('No description.')]);
  const long = text.length > 1200;
  section('desc', '', [
    el('div', { class: 'prose', text: long && !descExpanded ? `${text.slice(0, 1200).trimEnd()}…` : text }),
    long ? linkBtn(descExpanded ? 'Show less' : 'Show all', () => {
      descExpanded = !descExpanded;
      renderDesc();
    }, 'footer-link') : null,
  ]);
}

function renderRelated() {
  const issue = data.jira.issue;
  if (!issue) return section('related', '', [note('—')]);
  const nodes = [];
  if (issue.parent) {
    nodes.push(el('div', { class: 'group-label', text: 'Parent' }), ticketLine(issue.parent, `${issue.parent.key} · ${issue.parent.status}`));
  }
  if (issue.subtasks.length) {
    nodes.push(el('div', { class: 'group-label', text: `Subtasks · ${issue.subtasks.filter((t) => t.category === 'done').length}/${issue.subtasks.length} done` }));
    nodes.push(issue.subtasks.map((t) => ticketLine(t)));
  }
  if (issue.links.length) {
    nodes.push(el('div', { class: 'group-label', text: 'Links' }));
    nodes.push(issue.links.map((t) => ticketLine(t, `${t.relation} · ${t.key}`)));
  }
  const count = (issue.parent ? 1 : 0) + issue.subtasks.length + issue.links.length;
  section('related', count || '', nodes.length ? nodes : [note('No parent, subtask or linked ticket.')]);
}

function renderComments() {
  const issue = data.jira.issue;
  if (!issue) return section('comments', '', [note('—')]);
  const list = [...issue.comments].reverse();
  section('comments', issue.commentCount || '', list.length
    ? list.map((c) => el('div', { class: 'comment' },
      el('div', { class: 'comment-head' }, el('strong', { text: c.author || 'Someone' }), el('span', { class: 'muted', text: ago(c.at) })),
      el('div', { class: 'prose', text: c.text.length > 600 ? `${c.text.slice(0, 600).trimEnd()}…` : c.text })))
    : [note('No comment yet.')]);
}

// --- side column -----------------------------------------------------------------------------

const EVENT_LABEL = { created: 'Created', status: 'Status', comment: 'Comment', 'pr-opened': 'PR', 'pr-merged': 'Merged', 'pr-closed': 'Closed' };

function renderActivity() {
  const events = data.timeline.slice(0, 20);
  section('activity', '', events.length
    ? [el('ol', { class: 'activity' }, ...events.map((e) => {
      const item = el('li', { class: `ev-${e.kind}` },
        el('div', { class: 'act-text' }, el('span', { class: 'act-kind', text: EVENT_LABEL[e.kind] || '' }), document.createTextNode(e.text)),
        el('div', { class: 'act-meta', text: [e.who, ago(e.at)].filter(Boolean).join(' · ') }));
      if (e.url) {
        item.classList.add('link');
        item.addEventListener('click', () => act({ type: 'pr', url: e.url }));
      }
      return item;
    }))]
    : [note('No activity found.')]);
}

function renderChat() {
  const list = data.chat || [];
  const search = linkBtn(`Search “${current}” in Chat →`, () => act({ type: 'chat-search', q: current }), 'footer-link');
  section('chat', list.length || '', [
    list.length
      ? list.slice(0, 8).map((m) => row({
        lead: ico('chat', 'chat', true),
        title: m.title,
        sub: m.snippet,
        trail: [el('span', { class: 'side', text: ago(m.at) })],
        tooltip: m.snippet,
        onClick: () => (m.group ? act({ type: 'chat', id: m.group }) : api.select('chat')),
      }))
      : note('No message naming it since Workrail started (only notified messages are seen).'),
    search,
  ]);
}

function renderMail() {
  const list = data.mail || [];
  const q = encodeURIComponent(`"${current}"`);
  section('mail', list.length || '', [
    list.length
      ? list.slice(0, 6).map((m) => row({
        lead: ico('mail', 'mail', true),
        title: m.from || m.subject,
        sub: m.subject,
        trail: [el('span', { class: 'side', text: ago(m.at) })],
        tooltip: m.snippet,
        onClick: () => act({ type: 'mail', url: m.url }),
      }))
      : note('No unread mail about it.'),
    linkBtn(`Search “${current}” in Mail →`, () => act({ type: 'mail', url: `https://mail.google.com/mail/u/0/#search/${q}` }), 'footer-link'),
  ]);
}

function renderMeetings() {
  const now = Date.now();
  const list = data.meetings || [];
  section('meetings', list.length || '', list.length
    ? list.map((m) => row({
      lead: ico('meeting', 'meeting', true),
      title: m.title,
      sub: `${new Date(m.start).toLocaleDateString([], { weekday: 'short' })} ${fmtTime(m.start)}–${fmtTime(m.end)}`,
      trail: [m.meetUrl && m.end > now ? smallBtn('Join', () => act({ type: 'meet', url: m.meetUrl }), m.start - now < 15 * 60000) : null],
      onClick: () => api.select('calendar'),
    }))
    : [note('No meeting today or tomorrow mentions it.')]);
}

function render() {
  if (!data) return;
  // No ticket data (Jira off, signed out, unknown key): the hero says why,
  // the Jira-only cards step aside.
  for (const id of ['desc', 'related', 'comments']) $(id).hidden = !data.jira.issue;
  renderHero();
  renderPRs();
  renderDesc();
  renderRelated();
  renderComments();
  renderActivity();
  renderChat();
  renderMail();
  renderMeetings();
}

// --- wiring -------------------------------------------------------------------------------------

api.onState((state) => {
  const first = !lastState;
  lastState = state;
  if (first && !current) renderStart();
  else if (!current && !$('start').hidden) renderStart();
  else if (data) renderHero(); // suggestions, Jira site
});
api.getState().then((state) => {
  lastState = state;
  fromHash();
});
api.onOpenItem(go);
api.onFocusSearch(focusFinder);
window.addEventListener('hashchange', fromHash);
api.agentStatus().then((st) => {
  agentName = st?.agent?.name || null;
  render();
});

// Fresh while looked at: CI finishes, reviews land, tickets move.
setInterval(() => {
  if (current && !document.hidden) load(current);
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && current && data && Date.now() - data.loadedAt > REFRESH_MS) load(current);
});
