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

class AuthError extends Error {}

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

  poll();
  return { refresh: poll, stop: () => clearTimeout(timer) };
}

module.exports = { start, DEFAULT_JQL };
