// Jira Cloud tickets assigned to the user, read with the REST API using the
// signed-in web session's cookies (the Jira view in the rail). No API token.
const { app, Notification } = require('electron');
const fs = require('fs');
const path = require('path');

const INTERVAL = 3 * 60 * 1000;
const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC';
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
const BASE_FIELDS = ['summary', 'status', 'priority', 'duedate', 'updated', 'issuetype', 'project'];

const seenFile = () => path.join(app.getPath('userData'), 'jira-seen.json');

class AuthError extends Error {
  name = 'AuthError';
}

// The sprint field holds an array of sprints; keep the active (else the
// latest future) one.
function pickSprint(value) {
  const sprints = Array.isArray(value) ? value : [];
  const s = sprints.find((x) => x.state === 'active') || sprints.find((x) => x.state === 'future');
  return s ? { name: s.name, state: s.state, endDate: s.endDate || null } : null;
}

const toIssue = (base, sprintField) => (i) => ({
  key: i.key,
  url: `${base}/browse/${i.key}`,
  summary: i.fields.summary || '',
  status: i.fields.status?.name || '',
  // new | indeterminate | done
  category: i.fields.status?.statusCategory?.key || 'new',
  priority: i.fields.priority?.name || '',
  type: i.fields.issuetype?.name || '',
  project: i.fields.project?.key || '',
  due: i.fields.duedate || null, // YYYY-MM-DD
  updated: i.fields.updated,
  sprint: sprintField ? pickSprint(i.fields[sprintField]) : null,
});

const ISSUE_FIELDS = ['created', 'assignee', 'reporter', 'description', 'parent', 'subtasks', 'issuelinks', 'comment'];

// Atlassian Document Format → plain text (descriptions, comments).
function adfText(doc) {
  const text = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text') text.push(n.text || '');
    if (n.type === 'hardBreak') text.push('\n');
    if (n.type === 'mention') text.push(n.attrs?.text || '');
    if (n.type === 'inlineCard') text.push(n.attrs?.url || '');
    if (n.type === 'listItem') text.push('• ');
    (n.content || []).forEach(walk);
    if (['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(n.type)) text.push('\n');
  };
  walk(doc);
  return text.join('').replace(/\n{3,}/g, '\n\n').trim();
}

const statusOf = (f) => ({ status: f?.status?.name || '', category: f?.status?.statusCategory?.key || 'new' });
const person = (u) => (u ? u.displayName || '' : '');

function toFullIssue(i, base, sprintField) {
  const f = i.fields || {};
  const links = (f.issuelinks || []).map((l) => {
    const other = l.outwardIssue || l.inwardIssue;
    if (!other) return null;
    return {
      key: other.key,
      summary: other.fields?.summary || '',
      ...statusOf(other.fields),
      relation: (l.outwardIssue ? l.type?.outward : l.type?.inward) || l.type?.name || 'relates to',
    };
  }).filter(Boolean);
  const comments = (f.comment?.comments || []).slice(-5).map((c) => ({
    author: person(c.author), at: c.created, text: adfText(c.body).slice(0, 2000),
  }));
  // Status changes only, oldest first.
  const history = (i.changelog?.histories || []).flatMap((h) => (h.items || [])
    .filter((x) => x.field === 'status')
    .map((x) => ({ at: h.created, author: person(h.author), from: x.fromString || '', to: x.toString || '' })))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  return {
    ...toIssue(base, sprintField)(i),
    created: f.created || null,
    assignee: person(f.assignee),
    reporter: person(f.reporter),
    description: adfText(f.description).slice(0, 20000),
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '', ...statusOf(f.parent.fields) } : null,
    subtasks: (f.subtasks || []).map((t) => ({ key: t.key, summary: t.fields?.summary || '', ...statusOf(t.fields) })),
    links,
    comments,
    commentCount: f.comment?.total ?? comments.length,
    history,
  };
}

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(seenFile(), 'utf8')));
  } catch {
    return null; // first run
  }
}

const keepAlive = new Set();
function notify(issue, onOpen) {
  const n = new Notification({ title: `Assigned to you · ${issue.key}`, body: `${issue.summary}\n${issue.status}${issue.priority ? ` · ${issue.priority}` : ''}` });
  keepAlive.add(n);
  n.on('click', () => onOpen(issue.url));
  n.on('close', () => keepAlive.delete(n));
  n.show();
}

function start({ ses, site, jql, onUpdate, onOpen }) {
  const base = `https://${site}`;
  let timer = null;
  let sprintField; // undefined = not looked up yet, null = none
  let seen = loadSeen();

  const get = async (p) => {
    const res = await ses.fetch(`${base}${p}`, {
      headers: { Accept: 'application/json', 'X-Atlassian-Token': 'no-check' },
      redirect: 'manual',
    });
    // Signed out: 401/403, or a redirect to the Atlassian login.
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      throw new AuthError(`HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const poll = async () => {
    clearTimeout(timer);
    try {
      // Anonymous search succeeds with 0 results, so check who we are first:
      // /myself is 401 when signed out.
      await get('/rest/api/3/myself');
      if (sprintField === undefined) {
        const fields = await get('/rest/api/3/field');
        sprintField = fields.find((f) => f.schema?.custom === SPRINT_SCHEMA)?.id || null;
      }
      const params = new URLSearchParams({
        jql: jql || DEFAULT_JQL,
        maxResults: '100',
        fields: [...BASE_FIELDS, sprintField].filter(Boolean).join(','),
      });
      const data = await get(`/rest/api/3/search/jql?${params}`);
      const issues = (data.issues || []).map(toIssue(base, sprintField));

      // Newly assigned tickets; first run or a big jump is absorbed silently.
      if (seen) {
        const fresh = issues.filter((i) => !seen.has(i.key));
        if (fresh.length <= 3) fresh.forEach((i) => notify(i, onOpen));
      }
      seen = new Set([...(seen || []), ...issues.map((i) => i.key)]);
      fs.writeFile(seenFile(), JSON.stringify([...seen]), () => {});

      onUpdate({ status: 'ok', site, issues, custom: !!jql, updatedAt: Date.now() });
    } catch (err) {
      const auth = err instanceof AuthError;
      if (!auth) console.error('[jira]', err.message);
      onUpdate({ status: auth ? 'auth' : 'error', site, issues: [], error: auth ? null : err.message });
    }
    timer = setTimeout(poll, INTERVAL);
  };

  // --- on-demand helpers (Home actions, standup, agent hand-off) -----------

  const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
  const transitionsCache = new Map(); // key → { at, list }

  // Workflow transitions available from the ticket's current status.
  async function transitions(key) {
    if (!KEY.test(key)) throw new Error('Invalid issue key');
    const hit = transitionsCache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.list;
    const data = await get(`/rest/api/3/issue/${key}/transitions`);
    const list = (data.transitions || []).map((t) => ({
      id: t.id, name: t.name, to: t.to?.name || t.name, category: t.to?.statusCategory?.key || '',
    }));
    transitionsCache.set(key, { at: Date.now(), list });
    return list;
  }

  async function transition(key, id) {
    if (!KEY.test(key) || !/^\d+$/.test(String(id))) throw new Error('Invalid transition');
    const res = await ses.fetch(`${base}/rest/api/3/issue/${key}/transitions`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
      body: JSON.stringify({ transition: { id: String(id) } }),
      redirect: 'manual',
    });
    if (res.status === 401 || res.status === 403) throw new AuthError(`Jira refused the change (HTTP ${res.status})`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.errorMessages?.join(' ') || Object.values(body.errors || {}).join(' ') || `HTTP ${res.status}`);
    }
    transitionsCache.delete(key);
    poll();
  }

  // Tickets whose status I changed since a date (standup "yesterday").
  async function movedSince(dateStr) {
    const jqlMoved = `status CHANGED BY currentUser() AFTER "${dateStr}" ORDER BY updated DESC`;
    const params = new URLSearchParams({ jql: jqlMoved, maxResults: '30', fields: 'summary,status' });
    const data = await get(`/rest/api/3/search/jql?${params}`);
    return (data.issues || []).map((i) => ({ key: i.key, summary: i.fields.summary || '', status: i.fields.status?.name || '' }));
  }

  // Plain-text description (Atlassian Document Format → text), for prompts.
  async function description(key) {
    if (!KEY.test(key)) throw new Error('Invalid issue key');
    const data = await get(`/rest/api/3/issue/${key}?fields=description,summary`);
    return { summary: data.fields?.summary || '', description: adfText(data.fields?.description) };
  }

  // Everything about one ticket, for the work item hub: details, parent,
  // subtasks, links, latest comments and status history.
  async function issue(key) {
    if (!KEY.test(key)) throw new Error('Invalid issue key');
    if (sprintField === undefined) {
      const fields = await get('/rest/api/3/field');
      sprintField = fields.find((f) => f.schema?.custom === SPRINT_SCHEMA)?.id || null;
    }
    const params = new URLSearchParams({
      fields: [...BASE_FIELDS, ...ISSUE_FIELDS, sprintField].filter(Boolean).join(','),
      expand: 'changelog',
    });
    return toFullIssue(await get(`/rest/api/3/issue/${key}?${params}`), base, sprintField);
  }

  poll();
  return { refresh: poll, stop: () => clearTimeout(timer), transitions, transition, movedSince, description, issue };
}

module.exports = { start, DEFAULT_JQL, adfText, toFullIssue, AuthError };
