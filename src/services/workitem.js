// Work item hub: everything about one issue key (PROJ-123) from every
// source, each with its own status so one failure never blanks the page.
// The fetching is injected (main.js) so the merging logic stays testable.
const keys = require('../keys');

const CACHE_MS = 60 * 1000;
const MENTIONS_MAX = 300;

const has = (key, ...texts) => keys.keysIn(...texts).includes(key);

// Chat messages that name an issue key, from notifications (DMs, mentions,
// followed threads). In memory only, never written to disk; messages
// without a key are not kept at all.
function createMentions(max = MENTIONS_MAX) {
  const list = [];
  return {
    add({ title, body, source, group = null, at = Date.now() }) {
      const found = keys.keysIn(title, body);
      if (!found.length) return false;
      list.push({ keys: found, source, group, title: String(title || '').slice(0, 200), snippet: String(body || '').slice(0, 280), at });
      if (list.length > max) list.splice(0, list.length - max);
      return true;
    },
    forKey: (key) => list.filter((m) => m.keys.includes(key)).map(({ keys: _k, ...m }) => m).reverse(),
    size: () => list.length,
  };
}

// Search results first (fresh CI, teammates' PRs), then PRs already known
// from the regular poll whose branch carries the key (search misses those).
function mergePRs(searched, local) {
  const seen = new Set();
  const out = [];
  for (const p of [...searched, ...local]) {
    const id = `${p.repo}#${p.number}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  const rank = (p) => (p.state === 'OPEN' || !p.state ? 0 : p.state === 'MERGED' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || new Date(b.updatedAt || b.mergedAt || 0) - new Date(a.updatedAt || a.mergedAt || 0));
}

// One chronological story: ticket created, status moves, PRs opened /
// merged / closed, latest comments. Newest first.
function buildTimeline(issue, prs) {
  const ev = [];
  if (issue?.created) ev.push({ at: issue.created, kind: 'created', text: `Created${issue.reporter ? ` by ${issue.reporter}` : ''}` });
  for (const h of issue?.history || []) ev.push({ at: h.at, kind: 'status', text: `${h.from || '—'} → ${h.to}`, who: h.author });
  for (const c of issue?.comments || []) ev.push({ at: c.at, kind: 'comment', text: c.text.split('\n')[0].slice(0, 140), who: c.author });
  for (const p of prs || []) {
    if (p.createdAt) ev.push({ at: p.createdAt, kind: 'pr-opened', text: `#${p.number} opened · ${p.title}`, who: p.author, repo: p.repo, number: p.number, url: p.url });
    if (p.state === 'MERGED' && p.mergedAt) ev.push({ at: p.mergedAt, kind: 'pr-merged', text: `#${p.number} merged`, repo: p.repo, number: p.number, url: p.url });
    if (p.state === 'CLOSED') ev.push({ at: p.updatedAt, kind: 'pr-closed', text: `#${p.number} closed without merge`, repo: p.repo, number: p.number, url: p.url });
  }
  return ev.filter((e) => e.at && !Number.isNaN(new Date(e.at).getTime()))
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

const matchMail = (key, entries) => {
  const seen = new Set();
  return (entries || []).filter((m) => {
    if (!has(key, m.subject, m.snippet) || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
};

const matchMeetings = (key, meetings) => (meetings || []).filter((m) => has(key, m.title, m.description))
  .map(({ description: _d, ...m }) => m);

const settle = async (fn) => {
  try {
    return { status: 'ok', value: await fn() };
  } catch (err) {
    return { status: err.code || (err.name === 'AuthError' || /^HTTP (401|403)/.test(err.message) ? 'auth' : 'error'), error: err.message };
  }
};

// deps: {
//   jira: { status, issue(key), transitions(key) } | null,
//   github: { status, search(key) } | null,
//   localPRs: [], mentions: createMentions(), mail: [], meetings: [],
// }
async function load(key, deps) {
  if (!keys.isKey(key)) throw new Error('Invalid issue key');
  const jiraOn = deps.jira && deps.jira.status !== 'disabled' && deps.jira.status !== 'unconfigured';
  const ghOn = deps.github && deps.github.status !== 'disabled';
  const [issueRes, trRes, prRes] = await Promise.all([
    jiraOn ? settle(() => deps.jira.issue(key)) : { status: 'off' },
    jiraOn ? settle(() => deps.jira.transitions(key)) : { status: 'off' },
    ghOn ? settle(() => deps.github.search(key)) : { status: 'off' },
  ]);
  // Jira answers 404 to signed-out users on private tickets.
  if (issueRes.status === 'error' && /HTTP 404/.test(issueRes.error) && deps.jira.status === 'auth') issueRes.status = 'auth';
  const localPRs = (deps.localPRs || []).filter((p) => keys.prKeys(p).includes(key));
  const prs = mergePRs(prRes.value || [], localPRs);
  const issue = issueRes.value || null;
  return {
    key,
    loadedAt: Date.now(),
    jira: { status: issueRes.status, error: issueRes.error || null, issue, transitions: trRes.value || [] },
    github: { status: prRes.status === 'ok' || prs.length ? 'ok' : prRes.status, error: prRes.error || null, prs, partial: prRes.status !== 'ok' && prs.length > 0 },
    chat: deps.mentions ? deps.mentions.forKey(key) : [],
    mail: matchMail(key, deps.mail),
    meetings: matchMeetings(key, deps.meetings),
    timeline: buildTimeline(issue, prs),
  };
}

module.exports = { load, createMentions, mergePRs, buildTimeline, matchMail, matchMeetings, CACHE_MS };
