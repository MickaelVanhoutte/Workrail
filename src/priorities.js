// Home view logic: what to do now, free slots, one-line summary. Pure
// functions over the shell state (see main.js) so they are easy to test.

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const HIGH_PRIORITY = /^(highest|blocker|critical)$/i;

const peopleReviews = (gh) => (gh?.reviews || []).filter((r) => !r.bot && !r.draft);

// --- actions ------------------------------------------------------------------

const MINE_RULES = {
  ready: { score: 75, tag: 'Ready to merge', button: 'Merge', reason: 'Your PR is approved and CI is green' },
  'ci-failed': { score: 70, tag: 'CI failing', button: 'Fix', reason: 'CI is failing on your PR' },
  changes: { score: 70, tag: 'Changes requested', button: 'Update', reason: 'A reviewer requested changes on your PR' },
  conflict: { score: 55, tag: 'Conflict', button: 'Resolve', reason: 'Your PR has conflicts with its base branch' },
};

function actions(state, now = Date.now()) {
  const out = [];

  // Meetings running or starting within 15 min.
  for (const m of state.calendar?.today || []) {
    const ongoing = m.start <= now && now < m.end;
    const soon = m.start > now && m.start - now <= 15 * MIN;
    if (!ongoing && !soon) continue;
    out.push({
      kind: 'meeting',
      title: m.title,
      detail: `${fmtTime(m.start)}–${fmtTime(m.end)}`,
      tag: ongoing ? 'Now' : `In ${Math.max(1, Math.round((m.start - now) / MIN))} min`,
      reason: ongoing ? 'This meeting is running' : 'This meeting starts within 15 minutes',
      score: 100,
      button: m.meetUrl ? 'Join' : 'Open',
      action: m.meetUrl ? { type: 'meet', url: m.meetUrl } : { type: 'view', name: 'calendar' },
    });
  }

  // Chat: people waiting on me first, spaces with notifications after.
  const convs = state.chat?.conversations || [];
  const direct = convs.filter((c) => c.kind === 'dm' || c.kind === 'group');
  if (direct.length > 3) {
    out.push({
      kind: 'chat',
      title: `${direct.length} unread direct messages`,
      detail: direct.map((c) => c.name).join(', '),
      tag: 'Direct messages',
      reason: 'People are waiting for your answer',
      score: 80,
      button: 'Open',
      action: { type: 'view', name: 'chat' },
    });
  } else {
    for (const c of direct) {
      out.push({
        kind: 'chat',
        title: c.name,
        detail: c.kind === 'dm' ? 'Unread direct message' : 'Unread group conversation',
        tag: c.kind === 'dm' ? 'Direct message' : 'Group',
        reason: 'Someone wrote to you directly',
        score: 80,
        button: 'Open',
        action: { type: 'chat', id: c.id },
      });
    }
  }
  for (const c of convs.filter((x) => x.kind === 'space' && x.notifications > 0)) {
    out.push({
      kind: 'chat',
      title: c.name,
      detail: 'Mention or followed thread',
      tag: plural(c.notifications, 'notification'),
      reason: 'You were mentioned or a thread you follow moved',
      score: 50,
      button: 'Open',
      action: { type: 'chat', id: c.id },
    });
  }

  // My PRs that need me (abandoned ones — no activity for 30 days — don't).
  for (const pr of state.github?.mine || []) {
    const rule = MINE_RULES[pr.status];
    if (!rule || now - new Date(pr.updatedAt).getTime() > 30 * DAY) continue;
    out.push({
      kind: 'pr',
      title: pr.title,
      detail: `${pr.repo}#${pr.number}`,
      tag: rule.tag,
      reason: rule.reason,
      score: rule.score,
      button: rule.button,
      // Ready: merge right from Home (confirmed in main); otherwise open it.
      action: pr.status === 'ready'
        ? { type: 'gh', kind: 'merge', repo: pr.repo, number: pr.number }
        : { type: 'pr', url: pr.url },
    });
  }

  // Reviews from people: the longer they wait, the higher.
  for (const r of peopleReviews(state.github)) {
    const days = Math.floor((now - new Date(r.requestedAt).getTime()) / DAY);
    out.push({
      kind: 'review',
      title: r.title,
      detail: `${r.repo}#${r.number} · by ${r.author}`,
      tag: r.approved ? 'Re-review' : days <= 0 ? 'Requested today' : `${days} d waiting`,
      // Approved before and re-requested (new commits): a quicker look.
      reason: r.approved ? 'You approved it; a new review was requested since'
        : days > 2 ? `Review requested ${days} days ago` : 'Review requested recently',
      score: r.approved ? 40 : days > 2 ? Math.min(75, 60 + days) : 45,
      button: 'Review',
      action: { type: 'pr', url: r.url },
    });
  }

  // Jira: my open tickets with a reason to act today.
  const today = new Date(now).toLocaleDateString('sv-SE'); // YYYY-MM-DD, local
  const tickets = state.jira?.issues || [];
  for (const t of tickets) {
    let rule = null;
    const idle = Math.floor((now - new Date(t.updated).getTime()) / DAY);
    if (t.due && t.due < today) {
      const late = Math.round((new Date(today) - new Date(t.due)) / DAY);
      rule = { score: 72, tag: `Overdue ${late} d`, reason: `Due date ${t.due} has passed` };
    } else if (t.due === today) {
      rule = { score: 68, tag: 'Due today', reason: 'This ticket is due today' };
    } else if (HIGH_PRIORITY.test(t.priority)) {
      rule = { score: 62, tag: t.priority, reason: `${t.priority} priority ticket assigned to you` };
    } else if (t.category === 'indeterminate' && idle >= 5) {
      rule = { score: 50, tag: `Idle ${idle} d`, reason: `In progress but not updated for ${idle} days` };
    }
    if (!rule) continue;
    out.push({
      kind: 'ticket',
      title: t.summary,
      detail: `${t.key} · ${t.status}${t.priority ? ` · ${t.priority}` : ''}`,
      ...rule,
      button: 'Open',
      action: { type: 'jira', url: t.url },
    });
  }
  // Obvious workflow moves (keys.js): PR opened → review, PR merged → next.
  for (const sug of state.jira?.suggestions || []) {
    const t = tickets.find((x) => x.key === sug.key);
    if (!t) continue;
    out.push({
      kind: 'ticket',
      title: `Move ${sug.key} to ${sug.target.to}`,
      detail: `${t.summary} · PR #${sug.pr.number} ${sug.kind === 'next' ? 'merged' : 'open'}`,
      tag: `→ ${sug.target.to}`,
      reason: sug.kind === 'next'
        ? `Its pull request ${sug.pr.repo}#${sug.pr.number} is merged, the ticket is still ${t.status}`
        : `Pull request ${sug.pr.repo}#${sug.pr.number} is open, the ticket is still ${t.status}`,
      score: 57,
      button: 'Move',
      action: { type: 'jira-move', key: sug.key, id: sug.target.id },
    });
  }

  // Sprint about to end with my tickets still open: one grouped item.
  const ending = tickets.filter((t) => t.sprint?.state === 'active' && t.sprint.endDate
    && new Date(t.sprint.endDate).getTime() > now && new Date(t.sprint.endDate).getTime() - now <= 2 * DAY);
  if (ending.length) {
    const end = new Date(ending[0].sprint.endDate).getTime();
    const days = Math.max(0, Math.ceil((end - now) / DAY));
    out.push({
      kind: 'ticket',
      title: `${plural(ending.length, 'ticket')} still open in ${ending[0].sprint.name}`,
      detail: ending.map((t) => t.key).join(', '),
      tag: days <= 1 ? 'Sprint ends tomorrow' : `Sprint ends in ${days} d`,
      reason: 'The sprint ends soon and these tickets are not done',
      score: 58,
      button: 'Open',
      action: { type: 'view', name: 'jira' },
    });
  }

  // Important unread mail from the last 24h.
  for (const m of state.gmail?.important || []) {
    out.push({
      kind: 'mail',
      title: m.subject,
      detail: m.from,
      tag: 'Important',
      reason: 'Unread mail marked Important by Gmail',
      score: 40,
      button: 'Open',
      action: { type: 'mail', url: m.url },
    });
  }

  // urgent: do it now; high: today; normal: when you can.
  for (const a of out) a.level = a.score >= 80 ? 'urgent' : a.score >= 60 ? 'high' : 'normal';
  return out.sort((a, b) => b.score - a.score);
}

// --- free slots -------------------------------------------------------------------

// Gaps of at least 30 min between now and the end of the workday.
function freeSlots(meetings, now = Date.now(), workdayEnd = '18:00') {
  const [h, m] = workdayEnd.split(':').map(Number);
  const end = new Date(now);
  end.setHours(h, m, 0, 0);
  let cursor = Math.ceil(now / (5 * MIN)) * 5 * MIN;
  if (cursor >= end.getTime()) return [];
  const busy = meetings
    .filter((x) => x.end > cursor && x.start < end.getTime())
    .sort((a, b) => a.start - b.start);
  const slots = [];
  for (const b of busy) {
    if (b.start - cursor >= 30 * MIN) slots.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (end.getTime() - cursor >= 30 * MIN) slots.push({ start: cursor, end: end.getTime() });
  return slots;
}

// --- summary ------------------------------------------------------------------------

function summary(state, now = Date.now()) {
  const parts = [];
  if (state.calendar?.status === 'ok') {
    const endOfDay = new Date(now).setHours(23, 59, 59, 999);
    const left = (state.calendar.today || []).filter((m) => m.end > now && m.start <= endOfDay).length;
    parts.push(left ? `${plural(left, 'meeting')} left` : 'no more meetings');
  }
  const reviews = peopleReviews(state.github).length;
  if (reviews) parts.push(plural(reviews, 'review'));
  const dms = (state.chat?.conversations || []).filter((c) => c.kind === 'dm' || c.kind === 'group').length;
  if (dms) parts.push(plural(dms, 'DM'));
  const active = (state.github?.mine || []).filter((p) => now - new Date(p.updatedAt).getTime() <= 30 * DAY);
  const ready = active.filter((p) => p.status === 'ready').length;
  if (ready) parts.push(`${plural(ready, 'PR')} ready to merge`);
  const failing = active.filter((p) => p.status === 'ci-failed').length;
  if (failing) parts.push(`${failing} failing CI`);
  const today = new Date(now).toLocaleDateString('sv-SE');
  const overdue = (state.jira?.issues || []).filter((t) => t.due && t.due <= today).length;
  if (overdue) parts.push(`${plural(overdue, 'ticket')} due`);
  const mails = (state.gmail?.important || []).length;
  if (mails) parts.push(plural(mails, 'important mail'));
  return parts.length ? parts.join(' · ') : 'Nothing urgent — enjoy your day';
}

module.exports = { actions, freeSlots, summary, fmtTime };
