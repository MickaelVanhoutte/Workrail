// Gmail from the Atom feeds, fetched with the signed-in Google session's
// cookies (no API, no OAuth): inbox unread count, and recent unread mail
// marked Important.
const BASE = 'https://mail.google.com/mail/u/0/feed/atom';
// Important label: "^iim" is its system name; "important" as fallback.
const IMPORTANT_FEEDS = [`${BASE}/%5Eiim`, `${BASE}/important`];
const INTERVAL = 60 * 1000;
const RECENT = 24 * 3600 * 1000;

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] || '').trim();

function parseFeed(xml) {
  const count = xml.match(/<fullcount>(\d+)<\/fullcount>/);
  if (!count) return null;
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: tag(e, 'id'),
    subject: tag(e, 'title') || '(no subject)',
    snippet: tag(e, 'summary'),
    from: tag(e.match(/<author>([\s\S]*?)<\/author>/)?.[1] || '', 'name'),
    url: decode(e.match(/<link[^>]*href="([^"]+)"/)?.[1] || '').replace(/^http:/, 'https:'),
    at: new Date(tag(e, 'issued') || tag(e, 'modified')).getTime() || 0,
  }));
  // Feed title: "Gmail - Inbox for jane.doe@corp.com"
  const account = xml.match(/<title>[^<]*?([\w.+-]+@[\w.-]+)[^<]*<\/title>/)?.[1] || null;
  return { unread: parseInt(count[1], 10), entries, account };
}

async function fetchFeed(ses, url) {
  const res = await ses.fetch(url, { redirect: 'manual' });
  // Redirect = signed out.
  if (!res.ok) throw new Error(`feed status ${res.status}`);
  const data = parseFeed(await res.text());
  if (!data) throw new Error('unexpected feed format');
  return data;
}

function start(ses, onUpdate) {
  let timer = null;
  let importantUrl = null; // which Important feed works, once known

  const fetchImportant = async () => {
    for (const url of importantUrl ? [importantUrl] : IMPORTANT_FEEDS) {
      try {
        const data = await fetchFeed(ses, url);
        importantUrl = url;
        // Since the last workday: on Monday, include the weekend.
        const window = new Date().getDay() === 1 ? 3 * RECENT : RECENT;
        return data.entries.filter((e) => Date.now() - e.at < window);
      } catch {
        // try the next one
      }
    }
    return null;
  };

  const poll = async () => {
    clearTimeout(timer);
    try {
      const inbox = await fetchFeed(ses, BASE);
      const important = await fetchImportant();
      onUpdate({ unread: inbox.unread, latest: inbox.entries.slice(0, 5), important, account: inbox.account });
    } catch (err) {
      console.error('[gmail]', err.message);
    }
    timer = setTimeout(poll, INTERVAL);
  };
  poll();
  return { refresh: poll, stop: () => clearTimeout(timer) };
}

module.exports = { start };
