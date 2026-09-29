// Home's Messages feed (src/feed.js): grouping per conversation, dismiss,
// sync with Chat's unread conversations (`node test/feed.test.cjs`).
const { createFeed, conversationOf, SETTLE_MS } = require('../src/feed.js');

let failed = 0;
const assert = (ok, msg) => {
  if (!ok) {
    console.error('FAIL:', msg);
    failed++;
  } else console.log('ok -', msg);
};

const t0 = 1_000_000;
const f = createFeed({ max: 5 });
const a1 = f.add({ title: 'Jane', body: 'hi', group: 'dm/a', at: t0 });
assert(a1 && f.size() === 1, 'message added');
assert(f.add({ title: 'Jane', body: 'hi', group: 'dm/a', at: t0 + 1000 }) === null, 'same message notified twice is kept once');
f.add({ title: 'Jane', body: 'still there?', group: 'dm/a', at: t0 + 2000 });
f.add({ title: 'Team', body: 'Bob: deploy done', group: 'space/b', at: t0 + 3000 });
f.add({ title: 'Someone', body: 'no conversation id', at: t0 + 4000 });
assert(f.list()[0].body === 'no conversation id' && !('seenUnread' in f.list()[0]) && !('noteId' in f.list()[0]), 'newest first, internal fields hidden');
assert(f.add({ title: 'x', body: 'y', icon: 'javascript:alert(1)', at: t0 }).icon === '', 'only https icons kept');

// Dismissing one message dismisses its conversation.
const gone = f.dismiss(a1.id);
assert(gone.length === 2 && gone.every((m) => m.group === 'dm/a'), 'dismiss removes the whole conversation');
assert(f.dismiss('nope').length === 0, 'unknown id: nothing removed');

// Sync: conversation seen unread, then read in Chat → leaves the feed.
const g = createFeed();
g.add({ title: 'A', body: '1', group: 'dm/a', at: t0 });
g.add({ title: 'B', body: '2', group: 'dm/b', at: t0 });
g.add({ title: 'C', body: '3', at: t0 });
g.sync([{ id: 'dm/a' }, { id: 'dm/b' }], t0 + 1000);
assert(g.size() === 3, 'unread conversations stay');
assert(g.sync([{ id: 'dm/b' }], t0 + 2000) === true && g.list().every((m) => m.group !== 'dm/a'), 'conversation read in Chat leaves the feed');
const h = createFeed();
h.add({ title: 'A', body: '1', group: 'dm/a', at: t0 });
h.sync([], t0 + 1000);
assert(h.size() === 1, 'never-unread message kept while Chat catches up');
h.sync([], t0 + SETTLE_MS + 1);
assert(h.size() === 0, 'never-unread message dropped once settled (read right away)');
g.sync([], t0 + 25 * 3600 * 1000);
assert(g.size() === 0, 'messages older than a day expire');

// Messages without (or with a wrong) conversation id: matched by name.
const convs = [{ id: 'space/o', name: 'Ops Alerts' }, { id: 'dm/j', name: 'Jane Doe' }];
assert(conversationOf('Alertbot (App) (Ops Alerts)', convs)?.id === 'space/o', 'space message matched by "Sender (Space)" title');
assert(conversationOf('Jane Doe', convs)?.id === 'dm/j' && conversationOf('Bob', convs) === null, 'DM matched by name');
const r = createFeed();
r.add({ title: 'Alertbot (App) (Ops Alerts)', body: 'alert 1', at: t0 });
r.add({ title: 'Alertbot (App) (Ops Alerts)', body: 'alert 2', group: 'space/wrong', at: t0 + 1 });
r.sync(convs, t0 + 1000);
assert(r.list().every((m) => m.group === 'space/o'), 'both messages attached to the conversation');
r.sync([], t0 + 2000);
assert(r.size() === 0, 'and leave the feed once it is read in Chat');

const c = createFeed({ max: 2 });
c.add({ title: '1', body: '1', group: 'dm/1', at: t0 });
c.add({ title: '2', body: '2', group: 'dm/2', at: t0 });
c.add({ title: '3', body: '3', group: 'dm/3', at: t0 });
assert(c.size() === 2 && c.list()[1].group === 'dm/2', 'capped, oldest dropped');
assert(c.clear().length === 2 && c.size() === 0, 'clear all');

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
