// Settings panel. The iCal secret is write-only here: the page is only told
// whether one is stored (settings.publicView in the main process).
const api = window.gslackShell;
const $ = (id) => document.getElementById(id);

const icalForm = $('ical-form');
const ical = $('ical');
const icalStatus = $('ical-status');
const reminder = $('reminder');
const github = $('github');
const githubTeams = $('github-teams');
const githubExclude = $('github-exclude');
const githubStatus = $('github-status');
const summaryTime = $('summary-time');
const workdayEnd = $('workday-end');
const jira = $('jira');
const jiraSite = $('jira-site');
const jiraJql = $('jira-jql');
const jiraStatus = $('jira-status');

let current = null;
let lastState = null;

const setStatus = (node, text, kind = '') => {
  node.textContent = text;
  node.className = `status ${kind}`;
};

const fmt = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function renderCalendarStatus() {
  if (!current) return;
  const cal = lastState?.calendar;
  if (!current.hasIcal) return setStatus(icalStatus, 'Not configured.');
  if (cal?.status === 'error') return setStatus(icalStatus, 'Saved, but the calendar could not be loaded. Check the address.', 'error');
  if (cal?.status !== 'ok') return setStatus(icalStatus, 'Saved. Loading…', 'ok');
  const next = cal.next;
  const detail = next
    ? `${next.ongoing ? 'Now' : 'Next'}: ${next.title} (${fmt(next.start)}–${fmt(next.end)})${next.meetUrl ? ' · Meet' : ''}`
    : 'No more meetings in the next 12 hours.';
  setStatus(icalStatus, `Connected ✓ — ${detail}`, 'ok');
}

const GH_STATUS = {
  ok: (g) => [`Connected ✓ — ${g.total ?? g.prs.length} pull request(s) waiting.`, 'ok'],
  loading: () => ['Loading…', ''],
  disabled: () => ['Off.', ''],
  'no-gh': () => ['GitHub CLI not found: install it with “brew install gh”, then “gh auth login”.', 'error'],
  auth: () => ['Not signed in: run “gh auth login” in a terminal.', 'error'],
  error: (g) => [`Error: ${g.error || 'unknown'}`, 'error'],
};

function renderGithubStatus() {
  const g = lastState?.github;
  if (!g) return;
  const [text, kind] = (GH_STATUS[g.status] || GH_STATUS.error)(g);
  setStatus(githubStatus, text, kind);
}

const JIRA_STATUS = {
  ok: (j) => [`Connected ✓ — ${j.issues.length} open ticket(s)${j.custom ? ' (custom filter)' : ''}.`, 'ok'],
  loading: () => ['Loading…', ''],
  disabled: () => ['Off.', ''],
  unconfigured: () => ['Enter your Jira site above (yourcompany.atlassian.net).', ''],
  auth: () => ['Not signed in: open Jira in the left bar and sign in once.', 'error'],
  error: (j) => [`Error: ${j.error || 'unknown'} — check the site and the filter.`, 'error'],
};

function renderJiraStatus() {
  const j = lastState?.jira;
  if (!j) return;
  const [text, kind] = (JIRA_STATUS[j.status] || JIRA_STATUS.error)(j);
  setStatus(jiraStatus, text, kind);
}

function renderSettings() {
  reminder.value = String(current.reminderMinutes);
  summaryTime.value = current.summaryTime;
  workdayEnd.value = current.workdayEnd;
  github.checked = !!current.github;
  githubTeams.checked = !!current.githubTeams;
  githubTeams.disabled = !current.github;
  if (document.activeElement !== githubExclude) githubExclude.value = (current.githubExclude || []).join('\n');
  jira.checked = !!current.jira;
  if (document.activeElement !== jiraSite) jiraSite.value = current.jiraSite || '';
  if (document.activeElement !== jiraJql) jiraJql.value = current.jiraJql || '';
  ical.placeholder = current.hasIcal
    ? '•••••••• (saved — paste a new address to replace it)'
    : 'https://calendar.google.com/calendar/ical/…/private-…/basic.ics';
  renderCalendarStatus();
}

async function save(patch) {
  const res = await api.saveSettings(patch);
  if (res?.error) return res;
  current = res;
  renderSettings();
  return res;
}

icalForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = ical.value.trim();
  if (!url) return;
  const res = await save({ icalUrl: url });
  if (res?.error) setStatus(icalStatus, res.error, 'error');
  else ical.value = '';
});
$('ical-remove').addEventListener('click', () => save({ icalUrl: '' }));
reminder.addEventListener('change', () => save({ reminderMinutes: Number(reminder.value) }));
summaryTime.addEventListener('change', () => save({ summaryTime: summaryTime.value }));
workdayEnd.addEventListener('change', () => save({ workdayEnd: workdayEnd.value }));
github.addEventListener('change', () => save({ github: github.checked }));
githubTeams.addEventListener('change', () => save({ githubTeams: githubTeams.checked }));
githubExclude.addEventListener('change', () => save({ githubExclude: githubExclude.value.split('\n') }));
jira.addEventListener('change', () => save({ jira: jira.checked }));
jiraSite.addEventListener('change', async () => {
  const res = await save({ jiraSite: jiraSite.value });
  if (res?.error) setStatus(jiraStatus, res.error, 'error');
});
jiraJql.addEventListener('change', () => save({ jiraJql: jiraJql.value }));

api.onState((s) => {
  lastState = s;
  renderCalendarStatus();
  renderGithubStatus();
  renderJiraStatus();
});
api.getState().then((s) => {
  lastState = s;
  renderGithubStatus();
  renderJiraStatus();
});
api.getSettings().then((s) => {
  current = s;
  renderSettings();
});
