// User settings in userData/settings.json. The iCal secret address is
// encrypted with safeStorage (macOS Keychain) and never logged.
const { app, safeStorage } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  reminderMinutes: 1,
  github: true,
  githubTeams: false,
  githubExclude: [],
  summaryTime: '08:55', // weekday morning summary; 'off' disables it
  workdayEnd: '18:00', // free slots end here
  lastSummaryDate: null,
  jira: true,
  jiraSite: '', // e.g. yourcompany.atlassian.net; empty = Jira not set up
  jiraJql: '', // empty = default: my open tickets
  icalEnc: null,
};

const events = new EventEmitter();
let cache = null;

const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function get(key) {
  return load()[key];
}

function set(patch) {
  load();
  const changed = Object.keys(patch).filter((k) => k in DEFAULTS && JSON.stringify(cache[k]) !== JSON.stringify(patch[k]));
  if (!changed.length) return;
  for (const k of changed) cache[k] = patch[k];
  save();
  events.emit('change', changed);
}

function getIcalUrl() {
  const enc = get('icalEnc');
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

function setIcalUrl(url) {
  if (!url) return set({ icalEnc: null });
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption unavailable');
  set({ icalEnc: safeStorage.encryptString(url).toString('base64') });
}

// What local pages may see: everything except the secret itself.
function publicView() {
  const { icalEnc, ...rest } = load();
  return { ...rest, hasIcal: !!icalEnc };
}

module.exports = { get, set, getIcalUrl, setIcalUrl, publicView, events };
