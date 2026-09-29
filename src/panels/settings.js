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
const standupLanguage = $('standup-language');
const standupLead = $('standup-lead');
const standupMatch = $('standup-match');
const agentSel = $('agent');
const agentCommand = $('agent-command');
const terminalSel = $('terminal');
const codeFolders = $('code-folders');
const agentStatusEl = $('agent-status');
const messageChips = $('message-chips');
const checkUpdates = $('check-updates');

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
  'no-gh': () => ['GitHub CLI not found: install it (cli.github.com), then run “gh auth login”.', 'error'],
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
  messageChips.checked = current.messageChips !== false;
  checkUpdates.checked = current.checkUpdates !== false;
  standupLanguage.value = current.standupLanguage || 'auto';
  standupLead.value = String(current.standupLead ?? 5);
  if (document.activeElement !== standupMatch) standupMatch.value = current.standupMatch || '';
  if (document.activeElement !== agentCommand) agentCommand.value = current.agentCommand || '';
  if (document.activeElement !== codeFolders) codeFolders.value = (current.codeFolders || []).join('\n');
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

// --- workflow
const option = (value, label) => {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
};

async function renderAgentStatus(opts) {
  const st = await api.agentStatus(opts);
  if (!st) return;
  const installed = new Set(st.agents.map((a) => a.id));
  agentSel.replaceChildren(
    option('auto', `Auto${st.agents[0] ? ` (${st.agents[0].name})` : ''}`),
    ...st.presets.map((p) => option(p.id, installed.has(p.id) ? p.name : `${p.name} (not found)`)),
    option('custom', 'Custom command…'),
  );
  agentSel.value = current?.agent || 'auto';
  $('agent-custom-row').hidden = agentSel.value !== 'custom';
  terminalSel.replaceChildren(
    option('auto', `Auto${st.terminals[0] ? ` (${st.terminals[0].name})` : ''}`),
    ...st.terminals.map((t) => option(t.id, t.name)),
  );
  terminalSel.value = current?.terminal || 'auto';
  if (!(current?.codeFolders || []).length && document.activeElement !== codeFolders) codeFolders.placeholder = st.folders.join('\n');
  const agentText = st.agent ? `${st.agent.name} ✓` : 'No AI agent found — install one or set a custom command';
  setStatus(agentStatusEl, `${agentText} · ${st.repos} repositories in ${st.folders.length} folder(s)`, st.agent ? 'ok' : 'error');
}

messageChips.addEventListener('change', () => save({ messageChips: messageChips.checked }));
checkUpdates.addEventListener('change', () => save({ checkUpdates: checkUpdates.checked }));
standupLanguage.addEventListener('change', () => save({ standupLanguage: standupLanguage.value }));
standupLead.addEventListener('change', () => save({ standupLead: Number(standupLead.value) }));
standupMatch.addEventListener('change', async () => {
  const res = await save({ standupMatch: standupMatch.value });
  if (res?.error) setStatus(agentStatusEl, res.error, 'error');
});
agentSel.addEventListener('change', async () => {
  $('agent-custom-row').hidden = agentSel.value !== 'custom';
  await save({ agent: agentSel.value });
  renderAgentStatus();
});
agentCommand.addEventListener('change', async () => {
  await save({ agentCommand: agentCommand.value });
  renderAgentStatus();
});
terminalSel.addEventListener('change', () => save({ terminal: terminalSel.value }));
codeFolders.addEventListener('change', async () => {
  await save({ codeFolders: codeFolders.value.split('\n') });
  renderAgentStatus({ rescan: true });
});
$('rescan').addEventListener('click', () => {
  setStatus(agentStatusEl, 'Scanning…');
  renderAgentStatus({ rescan: true });
});
jiraSite.addEventListener('change', async () => {
  const res = await save({ jiraSite: jiraSite.value });
  if (res?.error) setStatus(jiraStatus, res.error, 'error');
});
jiraJql.addEventListener('change', () => save({ jiraJql: jiraJql.value }));

const UPDATE_HELP = $('update-status').textContent;
function renderUpdateStatus() {
  const u = lastState?.update;
  const node = $('update-status');
  node.replaceChildren(document.createTextNode(u ? `Workrail ${u.version} is available. ` : UPDATE_HELP));
  if (u) {
    const a = document.createElement('a');
    a.href = u.url;
    a.textContent = 'Download';
    node.append(a);
  }
}

api.onState((s) => {
  lastState = s;
  renderUpdateStatus();
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
  renderAgentStatus();
});
