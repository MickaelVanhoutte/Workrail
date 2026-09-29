// Pull requests via the gh CLI (reuses its login; the token never passes
// through this app): reviews requested from the user, the user's own open
// PRs with their review / CI state, and the user's recently merged PRs.
// One GraphQL call per poll.
const { app, Notification, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const INTERVAL = 3 * 60 * 1000;
// Usual install locations (packaged apps may not inherit the shell's PATH).
const GH_CANDIDATES = {
  darwin: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
  linux: ['/usr/bin/gh', '/usr/local/bin/gh', '/snap/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh'],
  win32: [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
  ],
}[process.platform] || [];

// Direct requests only by default; team requests are opt-in (much noisier).
const reviewQuery = (teams) => `is:open is:pr ${teams ? 'review-requested' : 'user-review-requested'}:@me archived:false`;
const MINE_QUERY = 'is:open is:pr author:@me archived:false';
// Merged in the last 7 days: Jira "next step" suggestions and the standup.
const mergedQuery = () => `is:pr author:@me is:merged merged:>=${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}`;

const GRAPHQL = `
query($reviews: String!, $mine: String!, $merged: String!) {
  viewer { login }
  reviews: search(query: $reviews, type: ISSUE, first: 100) {
    issueCount
    nodes { ... on PullRequest {
      databaseId number title url state isDraft createdAt updatedAt headRefName
      repository { nameWithOwner }
      author { login avatarUrl __typename }
      viewerLatestReview { state }
      timelineItems(itemTypes: REVIEW_REQUESTED_EVENT, last: 20) {
        nodes { ... on ReviewRequestedEvent {
          createdAt
          requestedReviewer { __typename ... on User { login } ... on Team { slug } }
        } }
      }
    } }
  }
  mine: search(query: $mine, type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      databaseId number title url state isDraft createdAt updatedAt
      reviewDecision mergeable headRefName
      repository { nameWithOwner viewerDefaultMergeMethod }
      reviewRequests(first: 1) { totalCount }
      commits(last: 1) { nodes { commit { statusCheckRollup { state
        contexts(first: 30) { nodes { __typename
          ... on CheckRun { name conclusion detailsUrl }
          ... on StatusContext { context state targetUrl }
        } }
      } } } }
    } }
  }
  merged: search(query: $merged, type: ISSUE, first: 30) {
    nodes { ... on PullRequest {
      number title url mergedAt headRefName
      repository { nameWithOwner }
    } }
  }
}`;

const seenFile = () => path.join(app.getPath('userData'), 'github-seen.json');

const run = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) {
      err.stderr = stderr;
      reject(err);
    } else resolve(stdout);
  });
});

// Packaged apps get a minimal PATH on macOS/Linux: look in the usual
// places, then ask the user's login shell (or `where` on Windows).
let ghPath;
async function resolveGh() {
  if (ghPath !== undefined) return ghPath;
  ghPath = GH_CANDIDATES.find((p) => p && fs.existsSync(p)) || null;
  if (!ghPath) {
    try {
      const out = process.platform === 'win32'
        ? await run('where', ['gh'])
        : await run(process.env.SHELL || '/bin/sh', ['-lc', 'command -v gh']);
      ghPath = out.split(/\r?\n/)[0].trim() || null;
    } catch {
      ghPath = null;
    }
  }
  return ghPath;
}

// dependabot, renovate, Copilot…: GitHub marks these accounts as bots.
const isBot = (author) => author?.__typename === 'Bot' || /\[bot\]$/.test(author?.login || '');

function toReview(n, viewer) {
  // When was *I* asked? Latest request naming me (or one of my teams when
  // team requests are included); fall back to the PR's creation.
  const events = n.timelineItems?.nodes || [];
  const mine = events.filter((e) => e.requestedReviewer?.login === viewer);
  const requestedAt = (mine.length ? mine : events).at(-1)?.createdAt || n.createdAt;
  return {
    id: n.databaseId,
    number: n.number,
    title: n.title,
    url: n.url,
    repo: n.repository.nameWithOwner,
    author: n.author?.login || 'ghost',
    avatar: n.author?.avatarUrl || '',
    bot: isBot(n.author),
    draft: n.isDraft,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    requestedAt,
    branch: n.headRefName || '',
    // Already approved by me (Approve button hidden).
    approved: n.viewerLatestReview?.state === 'APPROVED',
  };
}

// One word for what my PR needs, most actionable first.
function mineStatus(n) {
  const ci = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null;
  if (n.isDraft) return 'draft';
  if (n.mergeable === 'CONFLICTING') return 'conflict';
  if (ci === 'FAILURE' || ci === 'ERROR') return 'ci-failed';
  if (n.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
  if (n.reviewDecision === 'APPROVED') return ci === 'PENDING' || ci === 'EXPECTED' ? 'ci-pending' : 'ready';
  if (ci === 'PENDING' || ci === 'EXPECTED') return 'ci-pending';
  return 'waiting';
}

// Failing checks: GitHub Actions jobs carry a run id (re-run, logs); other
// providers (SonarQube…) only a link.
function failedChecks(n) {
  const nodes = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  return nodes
    .filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(c.conclusion || c.state))
    .map((c) => {
      const url = c.detailsUrl || c.targetUrl || '';
      const runId = url.match(/\/actions\/runs\/(\d+)/)?.[1] || null;
      return { name: c.name || c.context || 'check', url, runId };
    });
}

const toMine = (n) => ({
  id: n.databaseId,
  number: n.number,
  title: n.title,
  url: n.url,
  repo: n.repository.nameWithOwner,
  status: mineStatus(n),
  pendingReviewers: n.reviewRequests?.totalCount || 0,
  branch: n.headRefName || '',
  mergeMethod: n.repository.viewerDefaultMergeMethod || 'MERGE',
  failed: failedChecks(n),
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
});

// "my-org/old-team-*" style patterns (case-insensitive, * = anything).
const toMatcher = (patterns) => {
  const res = patterns.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'));
  return (repo) => res.some((re) => re.test(repo));
};

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(seenFile(), 'utf8')));
  } catch {
    return null; // first run
  }
}

const keepAlive = new Set();
function notify(pr) {
  const n = new Notification({ title: `Review requested · ${pr.repo}#${pr.number}`, body: `${pr.title}\nby ${pr.author}` });
  keepAlive.add(n);
  n.on('click', () => shell.openExternal(pr.url));
  n.on('close', () => keepAlive.delete(n));
  n.show();
}

function start({ includeTeams = false, exclude = [], onUpdate }) {
  const excluded = toMatcher(exclude);
  let timer = null;
  let seen = loadSeen();

  const poll = async () => {
    clearTimeout(timer);
    const gh = await resolveGh();
    if (!gh) {
      onUpdate({ status: 'no-gh', reviews: [], mine: [] });
      return;
    }
    try {
      const out = await run(gh, ['api', 'graphql',
        '-f', `query=${GRAPHQL}`,
        '-f', `reviews=${reviewQuery(includeTeams)}`,
        '-f', `mine=${MINE_QUERY}`,
        '-f', `merged=${mergedQuery()}`]);
      const { data } = JSON.parse(out);
      const viewer = data.viewer.login;
      // The search index can lag behind merges/closes: trust the PR's own state.
      const open = (n) => n.repository && n.state === 'OPEN';
      const allReviews = data.reviews.nodes.filter(open).map((n) => toReview(n, viewer));
      const reviews = allReviews.filter((p) => !excluded(p.repo));
      const hidden = allReviews.length - reviews.length;
      const mine = data.mine.nodes.filter(open).map(toMine).filter((p) => !excluded(p.repo));
      const merged = data.merged.nodes.filter((n) => n.repository && !excluded(n.repository.nameWithOwner)).map((n) => ({
        number: n.number, title: n.title, url: n.url, mergedAt: n.mergedAt,
        branch: n.headRefName || '', repo: n.repository.nameWithOwner,
      }));

      // Notify genuinely new, recent requests from people. First run or a big
      // jump (e.g. team requests just turned on) is absorbed silently.
      if (seen) {
        const week = Date.now() - 7 * 86400000;
        const fresh = reviews.filter((p) => !p.bot && !seen.has(p.id) && new Date(p.requestedAt).getTime() > week);
        if (fresh.length <= 3) fresh.forEach(notify);
      }
      seen = new Set([...(seen || []), ...reviews.map((p) => p.id)]);
      fs.writeFile(seenFile(), JSON.stringify([...seen]), () => {});

      onUpdate({
        status: 'ok',
        viewer,
        reviews,
        mine,
        merged,
        total: data.reviews.issueCount - hidden,
        hidden,
        includeTeams,
        updatedAt: Date.now(),
      });
    } catch (err) {
      const msg = (err.stderr || err.message || '').trim();
      const auth = /auth|login|401/i.test(msg);
      console.error('[github]', msg);
      onUpdate({ status: auth ? 'auth' : 'error', reviews: [], mine: [], error: auth ? null : msg });
    }
    timer = setTimeout(poll, INTERVAL);
  };

  poll();
  return { refresh: poll, stop: () => clearTimeout(timer) };
}

// My activity in a time window (standup "yesterday"): PRs opened and
// reviews submitted. Uses search (the contributions API leaves out orgs with
// SSO), then keeps what really happened in the window: search dates are per
// day and "updated" also moves for others' activity.
const ACTIVITY_QUERY = `
query($opened: String!, $reviewed: String!) {
  viewer { login }
  opened: search(query: $opened, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number title url createdAt repository { nameWithOwner } } }
  }
  reviewed: search(query: $reviewed, type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number title url repository { nameWithOwner }
      reviews(last: 30) { nodes { author { login } state submittedAt } }
    } }
  }
}`;

async function contributions(from) {
  const gh = await resolveGh();
  if (!gh) throw new Error('GitHub CLI (gh) not found');
  const day = from.toISOString().slice(0, 10);
  const out = await run(gh, ['api', 'graphql', '-f', `query=${ACTIVITY_QUERY}`,
    '-f', `opened=is:pr author:@me created:>=${day}`,
    '-f', `reviewed=is:pr reviewed-by:@me -author:@me updated:>=${day}`]);
  const { data } = JSON.parse(out);
  const me = data.viewer.login;
  const since = from.getTime();
  const base = (n) => ({ number: n.number, title: n.title, url: n.url, repo: n.repository.nameWithOwner });
  return {
    opened: data.opened.nodes.filter((n) => n.repository && new Date(n.createdAt).getTime() >= since)
      .map((n) => ({ ...base(n), at: n.createdAt })),
    reviewed: data.reviewed.nodes.filter((n) => n.repository).map((n) => {
      const mine = (n.reviews?.nodes || []).filter((r) => r.author?.login === me && new Date(r.submittedAt).getTime() >= since);
      return mine.length ? { ...base(n), at: mine.at(-1).submittedAt, state: mine.at(-1).state } : null;
    }).filter(Boolean),
  };
}

module.exports = { start, mineStatus, resolveGh, run, contributions, toMatcher };
