// Standup text: yesterday (since the previous workday), today, blockers.
// Built from the shell state plus two on-demand reads (GitHub activity,
// Jira tickets moved). French or English; copied by the user, never posted.
const { app } = require('electron');

const DAY = 86400000;

// Start of the previous workday (Monday → Friday).
function windowStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const back = d.getDay() === 1 ? 3 : d.getDay() === 0 ? 2 : 1;
  d.setDate(d.getDate() - back);
  return d;
}

const T = {
  fr: {
    yesterday: (monday) => (monday ? 'Vendredi :' : 'Hier :'),
    today: "Aujourd'hui :",
    blockers: 'Points bloquants :',
    merged: (p) => `Mergé : ${p.title} (${p.repo.split('/')[1]}#${p.number})`,
    opened: (p) => `PR ouverte : ${p.title} (${p.repo.split('/')[1]}#${p.number})`,
    reviewed: (list) => `Reviewé : ${list}`,
    moved: (t) => `${t.key} → ${t.status}`,
    doing: (t) => `${t.key} ${t.summary}`,
    reviews: (n, days) => `Reviews : ${n} PR à relire${days > 0 ? ` (la plus ancienne attend depuis ${days} j)` : ''}`,
    fix: (p) => `Corriger la CI de ${p.repo.split('/')[1]}#${p.number}`,
    merge: (p) => `Merger ${p.repo.split('/')[1]}#${p.number}`,
    ciFailed: (p) => `${p.repo.split('/')[1]}#${p.number} : CI en échec`,
    waiting: (p, days) => `${p.repo.split('/')[1]}#${p.number} en attente de review depuis ${days} j`,
    overdue: (t) => `${t.key} en retard (échéance ${t.due})`,
    nothing: 'Rien de particulier',
    none: 'Aucun',
  },
  en: {
    yesterday: (monday) => (monday ? 'Friday:' : 'Yesterday:'),
    today: 'Today:',
    blockers: 'Blockers:',
    merged: (p) => `Merged: ${p.title} (${p.repo.split('/')[1]}#${p.number})`,
    opened: (p) => `Opened: ${p.title} (${p.repo.split('/')[1]}#${p.number})`,
    reviewed: (list) => `Reviewed: ${list}`,
    moved: (t) => `${t.key} → ${t.status}`,
    doing: (t) => `${t.key} ${t.summary}`,
    reviews: (n, days) => `Reviews: ${n} PR${n > 1 ? 's' : ''} to review${days > 0 ? ` (oldest waiting ${days} d)` : ''}`,
    fix: (p) => `Fix CI on ${p.repo.split('/')[1]}#${p.number}`,
    merge: (p) => `Merge ${p.repo.split('/')[1]}#${p.number}`,
    ciFailed: (p) => `${p.repo.split('/')[1]}#${p.number}: CI failing`,
    waiting: (p, days) => `${p.repo.split('/')[1]}#${p.number} waiting for review for ${days} d`,
    overdue: (t) => `${t.key} overdue (due ${t.due})`,
    nothing: 'Nothing special',
    none: 'None',
  },
};

function language(setting) {
  if (setting === 'fr' || setting === 'en') return setting;
  return (app.getLocale() || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

const days = (iso, now) => Math.floor((now - new Date(iso).getTime()) / DAY);

// deps: { contributions(from), movedSince(dateStr), isHidden(repo) }, all optional.
async function build(state, deps, { lang: langSetting, now = Date.now() } = {}) {
  const lang = language(langSetting);
  const t = T[lang];
  const from = windowStart(new Date(now));
  const monday = new Date(now).getDay() === 1;
  const gh = state.github || {};
  const isHidden = deps.isHidden || (() => false);

  const [activity, moved] = await Promise.all([
    deps.contributions ? deps.contributions(from).catch(() => null) : null,
    deps.movedSince ? deps.movedSince(from.toLocaleDateString('sv-SE')).catch(() => null) : null,
  ]);

  // --- yesterday
  const y = [];
  const merged = (gh.merged || []).filter((p) => new Date(p.mergedAt).getTime() >= from.getTime());
  merged.forEach((p) => y.push(t.merged(p)));
  const mergedIds = new Set(merged.map((p) => `${p.repo}#${p.number}`));
  (activity?.opened || []).filter((p) => !mergedIds.has(`${p.repo}#${p.number}`) && !isHidden(p.repo))
    .forEach((p) => y.push(t.opened(p)));
  const reviewed = (activity?.reviewed || []).filter((p) => !isHidden(p.repo)).map((p) => `${p.repo.split('/')[1]}#${p.number}`);
  if (reviewed.length) y.push(t.reviewed(reviewed.join(', ')));
  const projects = new Set((state.jira?.issues || []).map((i) => i.project));
  (moved || []).filter((m) => !projects.size || projects.has(m.key.split('-')[0])).forEach((m) => y.push(t.moved(m)));

  // --- today
  const td = [];
  const tickets = state.jira?.issues || [];
  tickets.filter((i) => i.category === 'indeterminate').slice(0, 4).forEach((i) => td.push(t.doing(i)));
  const active = (gh.mine || []).filter((p) => days(p.updatedAt, now) < 30);
  active.filter((p) => p.status === 'ready').forEach((p) => td.push(t.merge(p)));
  active.filter((p) => p.status === 'ci-failed').forEach((p) => td.push(t.fix(p)));
  const toReview = (gh.reviews || []).filter((r) => !r.bot && !r.draft);
  if (toReview.length) {
    const oldest = Math.max(...toReview.map((r) => days(r.requestedAt, now)));
    td.push(t.reviews(toReview.length, oldest));
  }

  // --- blockers
  const b = [];
  active.filter((p) => p.status === 'ci-failed').forEach((p) => b.push(t.ciFailed(p)));
  active.filter((p) => p.status === 'waiting' && days(p.createdAt, now) > 2)
    .forEach((p) => b.push(t.waiting(p, days(p.createdAt, now))));
  const today = new Date(now).toLocaleDateString('sv-SE');
  tickets.filter((i) => i.due && i.due < today).forEach((i) => b.push(t.overdue(i)));

  const section = (title, items, empty) => [title, ...(items.length ? items : [empty]).map((x) => `- ${x}`)].join('\n');
  const text = [
    section(t.yesterday(monday), y, t.nothing),
    section(t.today, td, t.nothing),
    section(t.blockers, b, t.none),
  ].join('\n\n');
  return { text, lang, generatedAt: now, partial: !activity || !moved };
}

module.exports = { build, windowStart, language };
