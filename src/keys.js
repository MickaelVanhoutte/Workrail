// Issue keys in PR titles and branch names ("[PROJ-123] …",
// "feat/proj-123-thing") link pull requests and tickets. Branches are often
// lower-case, so match case-insensitively and normalise to upper case; only
// keys of the user's own tickets are ever looked up, so stray matches are
// harmless.
const KEY_RE = /\b([A-Za-z][A-Za-z0-9_]+-\d+)\b/g;

function keysIn(...texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t || '').matchAll(KEY_RE)) out.add(m[1].toUpperCase());
  return [...out];
}

const prKeys = (pr) => keysIn(pr.title, pr.branch);

// Jira "what's next" per ticket, from my open and recently merged PRs:
//   to-review: ticket not in a review status, an open PR references it
//   next:      ticket not done, a merged PR references it and no open PR does
const REVIEW_RE = /review/i;

function candidates(issues, openPRs, mergedPRs) {
  const byKey = (list) => {
    const map = new Map();
    for (const pr of list) for (const k of prKeys(pr)) map.set(k, [...(map.get(k) || []), pr]);
    return map;
  };
  const open = byKey(openPRs);
  const merged = byKey(mergedPRs);
  const out = [];
  for (const t of issues) {
    if (t.category === 'done') continue;
    const o = open.get(t.key) || [];
    const m = merged.get(t.key) || [];
    if (o.length && !REVIEW_RE.test(t.status)) out.push({ key: t.key, kind: 'to-review', pr: o[0] });
    else if (!o.length && m.length) out.push({ key: t.key, kind: 'next', pr: m[0] });
  }
  return out;
}

// Pick the transition to suggest among those the workflow offers (never
// hard-coded status names). After a merge the usual next step is testing,
// then deployment, then a "done" status — but not closing/archiving.
const TEST_RE = /test|qa|valid|verif|recette/i;
const DEPLOY_RE = /deploy|release|livr/i;
const END_RE = /clos|archiv|cancel|won.?t|reject|abandon|duplicate/i;

const shortest = (list) => list.sort((a, b) => a.to.length - b.to.length)[0] || null;

function pickTransition(kind, transitions) {
  if (kind === 'to-review') return shortest(transitions.filter((t) => REVIEW_RE.test(t.to)));
  return shortest(transitions.filter((t) => TEST_RE.test(t.to)))
    || shortest(transitions.filter((t) => DEPLOY_RE.test(t.to)))
    || shortest(transitions.filter((t) => t.category === 'done' && !END_RE.test(t.to)))
    || null;
}

module.exports = { keysIn, prKeys, candidates, pickTransition };
