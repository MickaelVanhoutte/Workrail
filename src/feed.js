// Latest Chat messages for Home ("Messages" card), built from the
// notifications Chat sends. In memory only: lost on restart, never written
// to disk. Chat tracks read state per conversation, so the feed does too:
// dismissing a message dismisses its conversation.
const MAX = 60;
// A message whose conversation never shows as unread in Chat's sidebar was
// read right away (you had it open): drop it after this delay.
const SETTLE_MS = 90 * 1000;
const MAX_AGE_MS = 24 * 3600 * 1000;
const DUP_MS = 2 * 60 * 1000;

// Chat titles notifications "Sender (Space name)" in spaces and "Sender" in
// DMs: find the conversation by name.
function conversationOf(title, conversations) {
  const t = String(title || '').trim();
  if (!t) return null;
  return conversations.find((c) => c.name && t.endsWith(`(${c.name})`))
    || conversations.find((c) => c.name && c.name === t)
    || null;
}

function createFeed({ max = MAX } = {}) {
  let items = []; // newest first
  let seq = 0;

  const byGroup = (group) => (it) => group && it.group === group;

  return {
    // n: { title, body, icon, group, source, noteId, at }
    add(n) {
      const at = n.at || Date.now();
      const title = String(n.title || '').slice(0, 200);
      const body = String(n.body || '').slice(0, 400);
      // Same message notified twice (page + service worker, edits).
      if (items.some((it) => it.title === title && it.body === body && it.group === (n.group || null) && at - it.at < DUP_MS)) return null;
      const item = {
        id: `f${++seq}`, title, body,
        icon: /^https:\/\//.test(n.icon || '') ? String(n.icon).slice(0, 1000) : '',
        group: n.group || null, source: n.source || 'chat', noteId: n.noteId || null,
        at, seenUnread: false,
      };
      items.unshift(item);
      if (items.length > max) items.length = max;
      return item;
    },

    get: (id) => items.find((it) => it.id === id) || null,

    // Removes the item and every other message of its conversation; returns
    // the removed items.
    dismiss(id) {
      const hit = items.find((it) => it.id === id);
      if (!hit) return [];
      const gone = items.filter((it) => it === hit || byGroup(hit.group)(it));
      items = items.filter((it) => !gone.includes(it));
      return gone;
    },

    dismissGroup(group) {
      const gone = items.filter(byGroup(group));
      items = items.filter((it) => !gone.includes(it));
      return gone;
    },

    clear() {
      const gone = items;
      items = [];
      return gone;
    },

    // Unread conversations from Chat's sidebar ([{ id, name }]): messages
    // without a (known) conversation are matched by name, and a
    // conversation read in Chat leaves the feed. Returns true when
    // something changed.
    sync(conversations, now = Date.now()) {
      const unreadGroups = new Set(conversations.map((c) => c.id));
      let changed = false;
      for (const it of items) {
        if (it.seenUnread || (it.group && unreadGroups.has(it.group))) continue;
        const conv = conversationOf(it.title, conversations);
        if (conv && conv.id !== it.group) {
          it.group = conv.id;
          changed = true;
        }
      }
      const before = items.length;
      items = items.filter((it) => {
        if (now - it.at > MAX_AGE_MS) return false;
        if (!it.group) return true;
        if (unreadGroups.has(it.group)) {
          it.seenUnread = true;
          return true;
        }
        return !it.seenUnread && now - it.at < SETTLE_MS;
      });
      return changed || items.length !== before;
    },

    // What panels get (no internal flags).
    list: () => items.map(({ seenUnread: _s, noteId: _n, ...it }) => it),
    size: () => items.length,
  };
}

module.exports = { createFeed, conversationOf, SETTLE_MS };
