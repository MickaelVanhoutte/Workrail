// Work item hub and update check: key handling, PR matching, Jira parsing,
// timeline, Chat mentions, version compare. Pure logic, no network
// (`node test/workitem.test.cjs`).
const Module = require('module');
const os = require('os');
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { getPath: () => os.tmpdir() }, net: {}, Notification: class {}, shell: {} };
  return orig.call(this, req, ...rest);
};
const keys = require('../src/keys.js');
const wi = require('../src/services/workitem.js');
const jira = require('../src/services/jira.js');
const github = require('../src/services/github.js');
const updates = require('../src/services/updates.js');

let failed = 0;
const assert = (ok, msg) => {
  if (!ok) {
    console.error('FAIL:', msg);
    failed++;
  } else console.log('ok -', msg);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- keys -----------------------------------------------------------------------
assert(keys.isKey('PROJ-123') && keys.isKey('AB_C-1'), 'valid keys accepted');
assert(!keys.isKey('proj-123') && !keys.isKey('PROJ-') && !keys.isKey('PROJ-1 OR 1=1') && !keys.isKey('../PROJ-1') && !keys.isKey(42), 'invalid keys rejected');
assert(keys.branchSlug('PROJ-7', 'Réparer le formulaire: login!') === 'proj-7-reparer-le-formulaire-login', 'branch slug strips accents and punctuation');
assert(keys.branchSlug('PROJ-7', '') === 'proj-7', 'branch slug without summary');
assert(!keys.branchSlug('PROJ-7', 'a'.repeat(39) + ' b').endsWith('-'), 'branch slug never ends with a dash');

// --- GitHub search query ------------------------------------------------------------
assert(github.keySearchQuery('PROJ-1', ['acme', 'acme', 'other-org']) === '"PROJ-1" is:pr archived:false org:acme org:other-org', 'search scoped to known orgs');
assert(github.keySearchQuery('PROJ-1', []).endsWith('involves:@me'), 'no known org: only PRs involving me');
assert(!github.keySearchQuery('PROJ-1', ['acme org:evil', 'a"b']).includes('evil'), 'owner names are validated');

// --- PR merge -----------------------------------------------------------------------
const merged = wi.mergePRs(
  [{ repo: 'o/r', number: 2, state: 'MERGED', mergedAt: '2026-09-01T00:00:00Z' }, { repo: 'o/r', number: 3, state: 'OPEN', updatedAt: '2026-09-02T00:00:00Z' }],
  [{ repo: 'o/r', number: 3, title: 'local copy' }, { repo: 'o/s', number: 9, updatedAt: '2026-09-03T00:00:00Z' }],
);
assert(eq(merged.map((p) => `${p.repo}#${p.number}`), ['o/s#9', 'o/r#3', 'o/r#2']), 'PRs deduplicated, open first, newest first');
assert(merged.find((p) => p.number === 3).title !== 'local copy', 'search result wins over local copy');

// --- Jira parsing -------------------------------------------------------------------
const adf = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'mention', attrs: { text: '@Jane' } }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
] };
assert(jira.adfText(adf) === 'Hello @Jane\n• one', 'ADF to text with mentions and bullets');
assert(jira.adfText(null) === '' && jira.adfText('x') === '', 'ADF: empty input');

const raw = {
  key: 'PROJ-5',
  fields: {
    summary: 'Do it', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'High' }, issuetype: { name: 'Story' }, project: { key: 'PROJ' },
    created: '2026-09-01T10:00:00Z', updated: '2026-09-03T10:00:00Z',
    assignee: { displayName: 'Jane' }, reporter: { displayName: 'Bob' },
    parent: { key: 'PROJ-1', fields: { summary: 'Epic', status: { name: 'Open', statusCategory: { key: 'new' } } } },
    subtasks: [{ key: 'PROJ-6', fields: { summary: 'Sub', status: { name: 'Done', statusCategory: { key: 'done' } } } }],
    issuelinks: [{ type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'PROJ-9', fields: { summary: 'Other', status: { name: 'Open' } } } }],
    comment: { total: 7, comments: [{ author: { displayName: 'Ann' }, created: '2026-09-02T09:00:00Z', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'LGTM' }] }] } }] },
  },
  changelog: { histories: [{ created: '2026-09-02T08:00:00Z', author: { displayName: 'Jane' }, items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }, { field: 'labels' }] }] },
};
const issue = jira.toFullIssue(raw, 'https://x.atlassian.net', null);
assert(issue.url === 'https://x.atlassian.net/browse/PROJ-5' && issue.assignee === 'Jane' && issue.category === 'indeterminate', 'full issue: base fields');
assert(issue.parent.key === 'PROJ-1' && issue.subtasks[0].category === 'done', 'full issue: parent and subtasks');
assert(issue.links[0].relation === 'is blocked by' && issue.links[0].key === 'PROJ-9', 'full issue: link direction');
assert(issue.commentCount === 7 && issue.comments[0].text === 'LGTM', 'full issue: comments');
assert(eq(issue.history, [{ at: '2026-09-02T08:00:00Z', author: 'Jane', from: 'To Do', to: 'In Progress' }]), 'full issue: status history only');

// --- timeline ----------------------------------------------------------------------
const tl = wi.buildTimeline(issue, [{ repo: 'o/r', number: 2, title: 'Fix', author: 'jane', createdAt: '2026-09-02T12:00:00Z', state: 'MERGED', mergedAt: '2026-09-04T00:00:00Z', url: 'u' }]);
assert(eq(tl.map((e) => e.kind), ['pr-merged', 'pr-opened', 'comment', 'status', 'created']), 'timeline newest first, all sources');

// --- mentions ------------------------------------------------------------------------
const m = wi.createMentions(3);
assert(m.add({ title: 'Jane', body: 'can you look at proj-12?', source: 'chat' }) === true, 'mention with a key kept');
assert(m.add({ title: 'Bob', body: 'lunch?', source: 'chat' }) === false && m.size() === 1, 'message without a key never stored');
for (let i = 0; i < 5; i++) m.add({ title: 'x', body: `PROJ-${i}`, source: 'chat' });
assert(m.size() === 3 && m.forKey('PROJ-12').length === 0, 'ring buffer drops the oldest');
assert(m.forKey('PROJ-4').length === 1 && !('keys' in m.forKey('PROJ-4')[0]), 'lookup by key');

// --- mail / meetings -------------------------------------------------------------------
assert(wi.matchMail('PROJ-2', [{ id: 1, subject: '[PROJ-2] deploy', snippet: '' }, { id: 1, subject: 'PROJ-2', snippet: '' }, { id: 2, subject: 'PROJ-22', snippet: '' }]).length === 1, 'mail: exact key, deduplicated');
const mt = wi.matchMeetings('PROJ-2', [{ title: 'Sync', description: 'about PROJ-2' }, { title: 'Other', description: '' }]);
assert(mt.length === 1 && !('description' in mt[0]), 'meetings: match in description, description not sent');

// --- load (injected sources) -----------------------------------------------------------
(async () => {
  const res = await wi.load('PROJ-5', {
    jira: { status: 'ok', issue: async () => issue, transitions: async () => [{ id: '1', to: 'Done' }] },
    github: { status: 'ok', search: async () => { throw Object.assign(new Error('gh down'), { code: 'error' }); } },
    localPRs: [{ repo: 'o/r', number: 4, title: 'feat', branch: 'feat/proj-5-x' }, { repo: 'o/r', number: 8, title: 'other', branch: 'main' }],
    mentions: m, mail: [], meetings: [],
  });
  assert(res.jira.status === 'ok' && res.jira.transitions.length === 1, 'load: Jira ok');
  assert(res.github.partial && res.github.prs.length === 1 && res.github.prs[0].number === 4, 'load: GitHub failure keeps local PRs matched by branch');
  const off = await wi.load('PROJ-5', { jira: { status: 'disabled' }, github: { status: 'disabled' } });
  assert(off.jira.status === 'off' && off.github.status === 'off', 'load: disabled sources reported as off');
  const auth = await wi.load('PROJ-5', { jira: { status: 'ok', issue: async () => { throw new jira.AuthError('HTTP 401'); }, transitions: async () => [] }, github: null });
  assert(auth.jira.status === 'auth', 'load: Jira sign-in needed');
  let threw = false;
  await wi.load('bad key', {}).catch(() => { threw = true; });
  assert(threw, 'load: invalid key refused');

  // --- updates -------------------------------------------------------------------------
  assert(updates.compare('0.3.0', '0.2.9') === 1 && updates.compare('v1.0.0', '1.0.0') === 0 && updates.compare('0.10.0', '0.9.0') === 1, 'version compare');
  assert(updates.compare('1.0.0-beta.1', '1.0.0') === -1 && updates.compare('1.0.0', '1.0.0-rc.1') === 1, 'pre-releases sort before release');
  assert(updates.repoSlug('https://github.com/Owner/Repo.git') === 'Owner/Repo' && updates.repoSlug('git@github.com:o/r.git') === 'o/r', 'repository slug');

  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
})();
