// Today's meetings from the calendar's secret iCal address: next-meeting
// info for the UI and a notification shortly before each meeting.
const { net, Notification, shell } = require('electron');
const ical = require('node-ical');

const FETCH_INTERVAL = 5 * 60 * 1000;
const TICK = 30 * 1000;
const MEET_RE = /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/;

const text = (v) => (v && typeof v === 'object' ? v.val : v) || '';

function declinedBy(event, email) {
  if (!email) return false;
  const attendees = [].concat(event.attendee || []);
  return attendees.some((a) => {
    const addr = text(a).replace(/^mailto:/i, '').toLowerCase();
    return addr === email && a.params?.PARTSTAT === 'DECLINED';
  });
}

function parse(ics) {
  const data = ical.sync.parseICS(ics);
  const owner = text(data.vcalendar?.['WR-CALNAME']).toLowerCase();
  const email = owner.includes('@') ? owner : null;
  const from = new Date(Date.now() - 12 * 3600 * 1000);
  const to = new Date(Date.now() + 36 * 3600 * 1000);
  const meetings = [];
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || ev.status === 'CANCELLED') continue;
    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    } catch {
      continue;
    }
    for (const inst of instances) {
      if (inst.isFullDay || declinedBy(inst.event, email)) continue;
      meetings.push({
        uid: ev.uid,
        title: text(inst.summary) || '(No title)',
        start: new Date(inst.start).getTime(),
        end: new Date(inst.end).getTime(),
        meetUrl: JSON.stringify(inst.event).match(MEET_RE)?.[0] || null,
      });
    }
  }
  return meetings.sort((a, b) => a.start - b.start);
}

// Ongoing meeting first, else the next one within the next 12h.
function pickNext(meetings, now = Date.now()) {
  const ongoing = meetings.find((m) => m.start <= now && now < m.end);
  if (ongoing) return { ...ongoing, ongoing: true };
  const next = meetings.find((m) => m.start > now && m.start - now < 12 * 3600 * 1000);
  return next ? { ...next, ongoing: false } : null;
}

const keepAlive = new Set();
function remind(m) {
  const mins = Math.max(0, Math.round((m.start - Date.now()) / 60000));
  const n = new Notification({
    title: m.title,
    body: mins ? `Starts in ${mins} min` : 'Starting now',
    actions: m.meetUrl ? [{ type: 'button', text: 'Join Meet' }] : [],
  });
  const join = () => m.meetUrl && shell.openExternal(m.meetUrl);
  keepAlive.add(n);
  n.on('click', join);
  n.on('action', join);
  n.on('close', () => keepAlive.delete(n));
  n.show();
}

function start({ getUrl, getLeadMinutes, onUpdate }) {
  let meetings = [];
  let status = 'unconfigured';
  let fetchTimer = null;
  const reminded = new Set();

  const emit = () => onUpdate({ status, next: pickNext(meetings), today: meetings });

  const fetchIcs = async () => {
    clearTimeout(fetchTimer);
    const url = getUrl();
    if (!url) {
      meetings = [];
      status = 'unconfigured';
      emit();
      return;
    }
    try {
      const res = await net.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      meetings = parse(await res.text());
      status = 'ok';
    } catch (err) {
      // Never log the URL itself: it is a secret.
      console.error('[calendar] fetch failed:', err.message);
      status = 'error';
    }
    emit();
    fetchTimer = setTimeout(fetchIcs, FETCH_INTERVAL);
  };

  const tick = () => {
    const now = Date.now();
    const lead = getLeadMinutes() * 60000;
    for (const m of meetings) {
      const key = `${m.uid}@${m.start}`;
      if (!reminded.has(key) && m.start - lead <= now && now < m.start + 60000) {
        reminded.add(key);
        remind(m);
      }
    }
    emit();
  };

  fetchIcs();
  const tickTimer = setInterval(tick, TICK);
  return {
    refresh: fetchIcs,
    stop: () => { clearTimeout(fetchTimer); clearInterval(tickTimer); },
  };
}

module.exports = { start, parse, pickNext };
