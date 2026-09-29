// Reviews panel: pull requests waiting for my review (data from the main
// process, fetched with the gh CLI).
const api = window.gslackShell;
const content = document.getElementById('content');
const meta = document.getElementById('meta');
const refreshBtn = document.getElementById('refresh');

// el, ago, waited, emptyState: panels/common.js
const empty = emptyState;

const MESSAGES = {
  loading: () => empty('Loading…'),
  disabled: () => empty('Reviews are off', 'Turn them on in Settings.'),
  'no-gh': () => empty('GitHub CLI not found',
    el('span', {}, 'Install it with '), el('code', { text: 'brew install gh' }),
    el('span', {}, ', then run '), el('code', { text: 'gh auth login' }), el('span', {}, ' in a terminal.')),
  auth: () => empty('Not signed in to GitHub', el('span', {}, 'Run '), el('code', { text: 'gh auth login' }), el('span', {}, ' in a terminal, then Refresh.')),
};

function prRow(pr) {
  const avatar = pr.avatar ? el('img', { src: `${pr.avatar}&s=72`, alt: '' }) : el('span', { class: 'avatar-fallback' });
  const row = el('div', { class: 'pr', role: 'link', tabindex: '0', title: pr.url },
    avatar,
    el('div', { class: 'pr-body' },
      el('div', { class: 'pr-title' }, document.createTextNode(pr.title), pr.draft ? el('span', { class: 'tag', text: 'Draft' }) : null),
      el('div', { class: 'pr-meta' },
        el('span', { class: 'repo', text: `${pr.repo}#${pr.number}` }),
        document.createTextNode(` · ${pr.author} · ${waited(pr.requestedAt || pr.createdAt)} · updated ${ago(pr.updatedAt)}`))));
  const hide = el('button', { class: 'hide-repo', type: 'button', title: `Hide all pull requests from ${pr.repo}`, text: 'Hide repo' });
  hide.addEventListener('click', (e) => {
    e.stopPropagation();
    hideRepo(pr.repo);
  });
  row.append(hide);
  const open = () => api.openExternal(pr.url);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => e.key === 'Enter' && open());
  return row;
}

async function hideRepo(repo) {
  const current = (await api.getSettings())?.githubExclude || [];
  await api.saveSettings({ githubExclude: [...current, repo] });
}

const section = (title, rows) => (rows.length ? [el('div', { class: 'group', text: `${title} (${rows.length})` }), ...rows.map(prRow)] : []);

function render(state) {
  const gh = state?.github;
  if (!gh) return;
  refreshBtn.disabled = false;
  if (gh.status !== 'ok') {
    meta.textContent = '';
    const msg = MESSAGES[gh.status]?.() || empty('Could not load reviews', el('span', { text: gh.error || 'Unknown error' }));
    content.replaceChildren(msg);
    return;
  }
  // Longest wait first: the oldest request is the most overdue.
  const prs = [...(gh.reviews || [])].sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt));
  const cutoff = Date.now() - 30 * 86400000;
  const isRecent = (p) => new Date(p.updatedAt).getTime() > cutoff;
  // People first, then drafts, then bots (dependabot, Copilot…), stale last.
  const people = prs.filter((p) => isRecent(p) && !p.bot && !p.draft);
  const drafts = prs.filter((p) => isRecent(p) && !p.bot && p.draft);
  const bots = prs.filter((p) => isRecent(p) && p.bot);
  const stale = prs.filter((p) => !isRecent(p));

  const parts = [`${people.length} from people`];
  if (bots.length) parts.push(`${bots.length} from bots`);
  if (gh.includeTeams) parts.push('incl. team requests');
  if (gh.total > prs.length) parts.push(`showing ${prs.length} of ${gh.total}`);
  parts.push(`updated ${ago(gh.updatedAt)}`);
  meta.replaceChildren(document.createTextNode(parts.join(' · ')));
  if (gh.hidden) {
    const link = el('a', { href: '#', class: 'hidden-link', text: `${gh.hidden} hidden` });
    link.addEventListener('click', (e) => { e.preventDefault(); api.select('settings'); });
    meta.append(document.createTextNode(' · '), link);
  }

  if (!prs.length) {
    content.replaceChildren(empty('No reviews waiting 🎉', 'Pull requests that request your review show up here.'));
    return;
  }
  const staleGroup = stale.length
    ? el('details', { class: 'stale' }, el('summary', { class: 'group', text: `Older than 30 days (${stale.length})` }), ...stale.map(prRow))
    : null;
  content.replaceChildren(...[
    ...(people.length ? people.map(prRow) : [empty('Nothing from people 🎉', 'No human review request with activity in the last 30 days.')]),
    ...section('Drafts', drafts),
    ...section('Bots', bots),
    staleGroup,
  ].filter(Boolean));
}

refreshBtn.addEventListener('click', () => {
  refreshBtn.disabled = true;
  api.refresh('github');
});

api.onState(render);
api.getState().then(render);
setInterval(() => api.getState().then(render), 60000); // keep "x min ago" fresh
