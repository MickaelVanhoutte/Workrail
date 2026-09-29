// Injected into chat.google.com (main world) on every dom-ready and, in dev,
// every time this file changes. Must be idempotent.
//
// Google Chat enforces Trusted Types: never assign innerHTML, build DOM nodes.
(() => {
  window.__gslack?.destroy?.();

  // All DOM knowledge of Google Chat lives here. When Google changes its UI,
  // fix these (run `npm run dump` to inspect the live page).
  const SEL = {
    // Sidebar conversation entries (spaces + DMs), in display order.
    entries: 'span[role="listitem"][data-group-id]',
    entryLink: '[role="link"]',
    entryName: 'span[role="presentation"] > span[role="presentation"]:first-child',
    // Screen-reader prefix Chat puts in unread entries.
    unreadText: /^\s*Unread\b/,
    mutedText: /^\s*Muted\b/m,
    // Chat's own Home page (/app/home): recent conversations with the last
    // message, a timestamp and a "mark as read" button.
    homeItems: 'span[role="listitem"][data-group-id][data-is-unread]',
    homeMarkRead: 'button[data-item="mark-as-read"]',
    homeTime: '[data-absolute-timestamp]',
    // Person chips (the sender of the last message).
    personCard: '[data-hovercard-id]',
    // Conversation menu (the "⋮" of a sidebar entry, shown on hover) and its
    // "Mark as read" item (UI language dependent).
    entryMenuButton: 'button[aria-haspopup="menu"]',
    menuItem: '[role="menuitem"]',
    markReadText: /\b(Mark as read|Marquer comme lu)\b/i,
    // Sidebar count pills, e.g. aria-label="3 unread messages".
    badgeLabel: /^\d+ unread message/,
    // Container whose children are [sidebar, divider, main pane].
    panes: '[data-stack-panes]',
    topbar: 'header[role="banner"]',
    // Chat's own message search box, in the top bar.
    searchInput: 'header[role="banner"] form[role="search"] input',
    sidePanel: '[role="complementary"]',
    // aria-label "Home shortcut, 15 unread messages" = Chat's own total.
    homeShortcut: '[data-shortcut-type="1"]',
    // Elements inside Chat's centred max-width column (messages, composer).
    columnSeeds: 'c-wiz[data-topic-id], [data-is-room-compose-postbar]',
    composerInput: '[data-is-room-compose-postbar] [role="textbox"][contenteditable]',
    composerTool: '[data-emoji-picker-button-id]',
    // One message (a topic can hold several).
    messageRow: '[data-id][data-user-id]',
    authorHeading: 'span[role="heading"][aria-level="3"][data-member-id]',
    // How Chat labels your own messages (UI language dependent).
    selfLabel: /^(You|Vous|Moi)$/,
    account: 'a[aria-label^="Google Account"]',
    // Person avatars: messages, read receipts, sidebar DMs.
    avatars: [
      '[data-gslack="main"] [data-is-message="true"] img',
      '[data-gslack="main"] [data-user-fullname] [data-member-id] img',
      '[data-gslack="sidebar"] span[role="listitem"][data-group-id^="dm/"] img',
    ].join(','),
  };

  // Our own region/state markers, used by theme.css. Tagging from JS keeps
  // the CSS independent of Google's obfuscated class names.
  const TAG = 'data-gslack';

  const bridge = window.gslack || { setUnread() {}, notificationShown() {}, notificationClicked() {}, themeChanged() {}, log() {} };
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  };

  // --- theme toggle ---------------------------------------------------------

  const THEME_KEY = 'gslack-theme-off';
  const applyTheme = () => {
    let off = false;
    try { off = localStorage.getItem(THEME_KEY) === '1'; } catch {}
    document.documentElement.classList.toggle('gslack', !off);
    bridge.themeChanged(!off);
  };
  const toggleTheme = () => {
    try {
      localStorage.setItem(THEME_KEY, document.documentElement.classList.contains('gslack') ? '1' : '0');
    } catch {}
    applyTheme();
  };
  applyTheme();

  // --- sidebar model --------------------------------------------------------

  const entryName = (node) =>
    (node.querySelector(SEL.entryName)?.textContent || '').trim();

  // innerText, not textContent: every row carries a display:none "Unread"
  // label, only unread rows have a visible (screen-reader) one.
  const isUnread = (node) => SEL.unreadText.test(node.innerText || '');

  // Group id "space/AAQA9J3tZPg" is open when the URL is /app/chat/AAQA9J3tZPg.
  const isSelected = (node) => {
    const id = (node.dataset.groupId || '').split('/')[1];
    return !!id && location.pathname.split('/').includes(id);
  };

  function entries() {
    const list = [];
    for (const node of document.querySelectorAll(SEL.entries)) {
      const name = entryName(node);
      if (name) list.push({ node, name, unread: isUnread(node), selected: isSelected(node) });
    }
    return list;
  }

  const open = (entry) => (entry.node.querySelector(SEL.entryLink) || entry.node).click();

  // Open a conversation by group id ("dm/…", "space/…"), e.g. from Home.
  function openGroup(id) {
    const node = document.querySelector(`${SEL.entries}[data-group-id="${CSS.escape(id)}"]`);
    if (node) return open({ node });
    location.assign(`/app/chat/${id.split('/')[1]}`);
  }

  // Mark a conversation read without opening it (Home's Messages feed), the
  // way a user would: the entry's "⋮" menu → "Mark as read". Resolves to
  // 'ok' | 'already-read' | 'not-found' | 'no-menu' | 'no-item'.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Chat has one shared conversation menu, filled in for the entry whose
  // button opened it (it stays in the page, invisible, when closed; and
  // never finishes its fade-in while the Chat view is hidden). So: wait for
  // this entry's button to be expanded, then use that menu's item.
  async function markRead(id) {
    const node = document.querySelector(`${SEL.entries}[data-group-id="${CSS.escape(id)}"]`);
    if (!node) return 'not-found';
    if (!isUnread(node)) return 'already-read';
    // Chat's Home page shows a direct "mark as read" button: simplest.
    const direct = homeItems().find((n) => n.dataset.groupId === id)?.querySelector(SEL.homeMarkRead);
    if (direct) {
      direct.click();
      for (let i = 0; i < 10 && isUnread(node); i++) await wait(100);
      if (!isUnread(node)) return 'ok';
    }
    const button = node.querySelector(SEL.entryMenuButton);
    if (!button) return 'no-menu';
    button.click();
    let item = null;
    for (let i = 0; i < 20 && !item; i++) {
      await wait(75);
      if (button.getAttribute('aria-expanded') !== 'true') continue;
      item = [...document.querySelectorAll(SEL.menuItem)].find((m) => SEL.markReadText.test(m.textContent || ''));
    }
    if (!item) {
      if (button.getAttribute('aria-expanded') === 'true') button.click(); // close it again
      return 'no-item';
    }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      item.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    item.click();
    for (let i = 0; i < 10 && isUnread(node); i++) await wait(100);
    if (button.getAttribute('aria-expanded') === 'true') button.click();
    return isUnread(node) ? 'still-unread' : 'ok';
  }

  // Run Chat's own message search (work item hub: "Search in Chat").
  function search(q) {
    const input = document.querySelector(SEL.searchInput);
    if (!input) return false;
    input.focus();
    // Set the value the way a user would, so Chat's framework sees it.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(q));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    input.dispatchEvent(new KeyboardEvent('keydown', enter));
    input.dispatchEvent(new KeyboardEvent('keyup', enter));
    return true;
  }

  // Last message of each conversation, read from Chat's Home page while it
  // is rendered, and remembered while you browse elsewhere in Chat.
  const previews = new Map(); // group id → { sender, text, at }
  const homeItems = () => [...document.querySelectorAll(SEL.homeItems)].filter((n) => !n.closest(`[${TAG}="sidebar"]`));
  // Child-index path from an item to a node, to find the same spot in
  // items built from the same template.
  const pathOf = (node, root) => {
    const path = [];
    for (let n = node; n && n !== root; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
    return path;
  };
  const nodeAt = (root, path) => path.reduce((n, i) => n?.children[i] || null, root);

  function readPreviews() {
    const items = homeItems();
    const senderOf = (it) => [...it.querySelectorAll(SEL.personCard)]
      .find((n) => n.dataset.hovercardId !== it.dataset.groupId && (n.innerText || '').trim());
    // Where the "sender: message" block sits, learnt from an item that has a
    // person chip; used for items without one (apps, bots).
    const model = items.find(senderOf);
    const blockPath = model ? pathOf(senderOf(model).parentElement, model) : null;
    for (const it of items) {
      const id = it.dataset.groupId;
      const time = it.querySelector(SEL.homeTime);
      const who = senderOf(it);
      let sender = (who?.innerText || '').trim().replace(/:$/, '');
      const block = who ? who.parentElement : blockPath && nodeAt(it, blockPath);
      let text = (block?.innerText || '').replace(/\s+/g, ' ').trim();
      if (sender && text.startsWith(sender)) text = text.slice(sender.length).replace(/^\s*:\s*/, '');
      else if (!sender) {
        const m = text.match(/^([^:]{1,40}):\s+(.+)$/);
        if (m) [, sender, text] = m;
      }
      const at = Number(time?.dataset.absoluteTimestamp || it.dataset.displayTimestamp) || null;
      if (text) previews.set(id, { sender: sender.slice(0, 80), text: text.slice(0, 300), at });
    }
  }

  // Unread conversations for Home. Chat's visible screen-reader labels tell
  // the kind ("Conversation" = group DM, "Meeting conversation", "Space") and
  // mentions/followed threads ("2 Notification").
  let lastConversations = '';
  function reportConversations() {
    readPreviews();
    const list = [];
    for (const e of entries()) {
      if (!e.unread) continue;
      const text = e.node.innerText || '';
      if (SEL.mutedText.test(text)) continue;
      const id = e.node.dataset.groupId;
      const kind = id.startsWith('dm/') ? 'dm'
        : /Meeting conversation/.test(text) ? 'meeting'
          : /\bConversation\b/.test(text) ? 'group' : 'space';
      const notifications = parseInt(text.match(/(\d+)\s+Notification/)?.[1] || '0', 10);
      list.push({ id, name: e.name, kind, notifications, preview: previews.get(id) || null });
    }
    const key = JSON.stringify(list);
    if (key !== lastConversations) {
      lastConversations = key;
      bridge.setConversations?.(list);
    }
  }

  // --- region tagging -------------------------------------------------------

  const setTag = (node, value) => {
    if (node && node.getAttribute(TAG) !== value) node.setAttribute(TAG, value);
  };
  const setFlag = (node, name, on) => {
    const attr = `${TAG}-${name}`;
    if (on && !node.hasAttribute(attr)) node.setAttribute(attr, '');
    else if (!on && node.hasAttribute(attr)) node.removeAttribute(attr);
  };

  const scannedRows = new WeakSet();

  // --- placeholder avatars → coloured initials -------------------------------
  // People without a photo get Google's grey silhouette. Detect it by pixels
  // (no colour, very few grey levels; real B&W photos have ~30) and show
  // initials instead, like Slack.

  const AVATAR_COLORS = ['#1264a3', '#2bac76', '#e01e5a', '#ecb22e', '#36c5f0', '#7c3085', '#e8912d', '#4a154b', '#0b4c8c', '#5a8f2e'];
  const placeholderCache = new Map();

  function isPlaceholder(src) {
    if (!placeholderCache.has(src)) {
      placeholderCache.set(src, (async () => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.src = src;
        await im.decode();
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const ctx = c.getContext('2d');
        ctx.drawImage(im, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let sat = 0;
        const levels = new Set();
        for (let k = 0; k < d.length; k += 4) {
          sat += Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]);
          levels.add(d[k] >> 3);
        }
        return sat / 256 < 3 && levels.size <= 10;
      })().catch(() => false));
    }
    return placeholderCache.get(src);
  }

  const initialsOf = (name) => {
    const words = name.replace(/[^\p{L}\s'-]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
  };
  const colorOf = (id) => {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  };

  // Name for an avatar wrapper, from the nearest place Chat shows it.
  function avatarName(wrap) {
    const receipt = wrap.closest('[data-user-fullname]');
    if (receipt) return receipt.dataset.userFullname;
    const entry = wrap.closest(SEL.entries);
    if (entry) return entryName(entry);
    const id = wrap.dataset.memberId;
    const heading = id && document.querySelector(`${SEL.authorHeading}[data-member-id="${id}"]`);
    return heading?.childNodes[0]?.textContent?.trim() || '';
  }

  function replacePlaceholderAvatars() {
    for (const img of document.querySelectorAll(SEL.avatars)) {
      const wrap = img.closest('[data-member-id], [data-hovercard-id]');
      if (!wrap || !img.src.includes('googleusercontent') || wrap.dataset.gslackAvSrc === img.src) continue;
      wrap.dataset.gslackAvSrc = img.src;
      isPlaceholder(img.src).then((placeholder) => {
        if (!placeholder || wrap.dataset.gslackAvSrc !== img.src) return;
        const name = avatarName(wrap);
        if (!name) return;
        const size = img.getBoundingClientRect().width || 32;
        wrap.style.setProperty('--gs-av-color', colorOf(wrap.dataset.memberId || wrap.dataset.hovercardId || name));
        wrap.style.setProperty('--gs-av-fs', `${Math.max(7, Math.round(size * 0.42))}px`);
        wrap.setAttribute(`${TAG}-initials`, initialsOf(name));
      });
    }
  }

  // --- DM bubbles → Slack rows ----------------------------------------------
  // DMs render messages as bubbles, own messages right-aligned. The bubble
  // and alignment wrappers have no attributes, so each message is scanned
  // once by computed style and flagged for theme.css.

  // Chat never renders your own name (always "You"): derive it from the
  // account email, e.g. jane.doe@corp.com → "Jane Doe".
  let selfName = null;
  function getSelfName() {
    if (selfName) return selfName;
    const label = document.querySelector(SEL.account)?.getAttribute('aria-label') || '';
    const local = label.match(/([\w.+-]+)@/)?.[1];
    if (!local) return 'You';
    return (selfName = local.split(/[._-]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' '));
  }

  function flattenBubbles(main) {
    for (const msg of main.querySelectorAll(`${SEL.messageRow}:not([${TAG}-msg])`)) {
      // Wait until the message has rendered its text.
      if (!msg.textContent.trim()) continue;
      msg.setAttribute(`${TAG}-msg`, '');
      for (const d of msg.querySelectorAll('div')) {
        const cs = getComputedStyle(d);
        if (cs.alignItems === 'flex-end' || cs.justifyContent === 'flex-end') {
          setFlag(d, 'start', true);
        }
        if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.borderRadius.includes('20px')) {
          setFlag(d, 'bubble', true);
        }
      }
      // Own messages: Chat keeps a screen-reader-only "You" heading and shows
      // no name. On the first message of a group (visible timestamp), show
      // the author name like Slack does.
      const heading = msg.querySelector(SEL.authorHeading);
      if (!heading || !SEL.selfLabel.test(heading.textContent.trim())) continue;
      setFlag(msg, 'self', true);
      const time = msg.querySelector('span[data-absolute-timestamp]');
      if (time && time.getBoundingClientRect().width > 0 && time.parentElement) {
        time.parentElement.setAttribute(`${TAG}-author`, getSelfName());
        setFlag(msg, 'grouphead', true);
        // Own avatar (Chat shows none): reuse the account photo.
        const photo = document.querySelector(`${SEL.account} img`)?.src;
        if (photo) document.documentElement.style.setProperty('--gs-self-avatar', `url("${photo}")`);
      }
    }
  }

  function tagRegions() {
    const topbar = document.querySelector(SEL.topbar);
    setTag(topbar, 'topbar');
    // The header has several children; only the one holding search is the bar row.
    const search = topbar?.querySelector('form[role="search"]');
    if (search) {
      let row = search;
      while (row.parentElement && row.parentElement !== topbar) row = row.parentElement;
      setTag(row, 'toprow');
      if (!scannedRows.has(row)) {
        scannedRows.add(row);
        // No stable selectors for these: the Ask Gemini fade (gradient span)
        // and the org-logo chip (white box without the avatar link).
        for (const el of row.querySelectorAll('span, div')) {
          // Only visible bar items; never menus/popups (also white).
          if (!el.getBoundingClientRect().width || el.closest('[role="menu"], [role="dialog"], [role="listbox"], [aria-hidden="true"]')) continue;
          const cs = getComputedStyle(el);
          const gradient = el.tagName === 'SPAN' && cs.backgroundImage.includes('gradient');
          const logoChip = cs.backgroundColor === 'rgb(255, 255, 255)' && !el.querySelector('a[aria-label^="Google Account"]') && !el.closest('form');
          if (gradient || logoChip) setFlag(el, 'hide', true);
        }
      }
    }
    const panes = document.querySelector(SEL.panes);
    if (panes && panes.children.length >= 3) {
      setTag(panes.children[0], 'sidebar');
      setTag(panes.children[1], 'divider');
      setTag(panes.children[2], 'main');
    }
    const side = document.querySelector(SEL.sidePanel);
    if (side?.parentElement) setTag(side.parentElement, 'sidepanel');

    // Chat centres messages and composer in a fixed max-width column; tag
    // that column so theme.css can make it full width like Slack.
    const main = document.querySelector(`[${TAG}="main"]`);
    if (main) {
      flattenBubbles(main);
      // Composer box = smallest ancestor holding both the input and the
      // emoji button (Slack draws one border around text + tools).
      const input = main.querySelector(SEL.composerInput);
      for (let el = input?.parentElement; el && el !== main; el = el.parentElement) {
        if (el.querySelector(SEL.composerTool)) {
          if (!el.hasAttribute(`${TAG}-composer`)) {
            main.querySelectorAll(`[${TAG}-composer]`).forEach((n) => setFlag(n, 'composer', false));
            setFlag(el, 'composer', true);
          }
          break;
        }
      }

      for (const start of main.querySelectorAll(SEL.columnSeeds)) {
        for (let el = start.parentElement; el && el !== main; el = el.parentElement) {
          if (el.hasAttribute(`${TAG}-column`)) break;
          if (getComputedStyle(el).maxWidth.endsWith('px')) { setFlag(el, 'column', true); break; }
        }
      }
    }

    for (const node of document.querySelectorAll(SEL.entries)) {
      setFlag(node, 'unread', isUnread(node));
      setFlag(node, 'selected', isSelected(node));
    }
    const sidebar = document.querySelector(`[${TAG}="sidebar"]`);
    if (sidebar) {
      for (const node of sidebar.querySelectorAll('[aria-label*="unread"]')) {
        setFlag(node, 'badge', SEL.badgeLabel.test(node.getAttribute('aria-label')));
      }
    }
  }

  function step(dir, unreadOnly) {
    const list = entries();
    if (!list.length) return;
    let i = list.findIndex((e) => e.selected);
    for (let n = 0; n < list.length; n++) {
      i = (i + dir + list.length) % list.length;
      if (!unreadOnly || list[i].unread) return open(list[i]);
    }
  }

  // --- quick switcher (⌘K, bound from the app menu) --------------------------

  let overlay = null;

  function score(name, q) {
    const n = name.toLowerCase();
    if (!q) return 1;
    if (n.startsWith(q)) return 100 - n.length;
    const idx = n.indexOf(q);
    if (idx >= 0) return 60 - idx;
    // subsequence match
    let j = 0;
    for (const ch of n) if (ch === q[j]) j++;
    return j === q.length ? 20 : -1;
  }

  function closeSwitcher() {
    overlay?.remove();
    overlay = null;
  }

  function openSwitcher() {
    if (overlay) return closeSwitcher();
    const all = entries();
    const input = el('input', { class: 'gslack-sw-input', placeholder: 'Jump to…', spellcheck: 'false' });
    const listEl = el('div', { class: 'gslack-sw-list', role: 'listbox' });
    const hint = el('div', { class: 'gslack-sw-hint', text: '↑↓ navigate · ↵ open · esc close' });
    const panel = el('div', { class: 'gslack-sw-panel' }, input, listEl, hint);
    overlay = el('div', { class: 'gslack-sw' }, panel);
    let results = [];
    let active = 0;

    const render = () => {
      const q = input.value.trim().toLowerCase();
      results = all
        .map((e) => ({ e, s: score(e.name, q) }))
        .filter((r) => r.s >= 0)
        .map((r) => ({ e: r.e, s: r.s + (r.e.unread ? 5 : 0) }))
        .sort((a, b) => (q ? b.s - a.s : (b.e.unread - a.e.unread)))
        .slice(0, 12)
        .map((r) => r.e);
      active = Math.min(active, Math.max(results.length - 1, 0));
      listEl.replaceChildren(...results.map((e, i) => {
        const row = el('div', { class: 'gslack-sw-row' + (i === active ? ' active' : '') + (e.unread ? ' unread' : ''), role: 'option' },
          el('span', { class: 'gslack-sw-name', text: e.name }),
          e.unread ? el('span', { class: 'gslack-sw-dot' }) : null);
        row.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(i); });
        return row;
      }));
      if (!results.length) listEl.append(el('div', { class: 'gslack-sw-empty', text: all.length ? 'No match' : 'Sidebar not found – selectors need tuning' }));
    };
    const pick = (i) => {
      const e = results[i];
      closeSwitcher();
      if (e) open(e);
    };

    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { active = Math.min(active + 1, results.length - 1); render(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); ev.preventDefault(); }
      else if (ev.key === 'Enter') { pick(active); ev.preventDefault(); }
      else if (ev.key === 'Escape') { closeSwitcher(); ev.preventDefault(); }
      ev.stopPropagation();
    });
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) closeSwitcher(); });

    document.body.append(overlay);
    render();
    input.focus();
  }

  // --- keyboard shortcuts ---------------------------------------------------

  on(window, 'keydown', (ev) => {
    if (overlay) return;
    if (ev.altKey && !ev.metaKey && !ev.ctrlKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      step(ev.key === 'ArrowUp' ? -1 : 1, ev.shiftKey);
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);

  // Notifications: see notify.js (injected into every Google view).

  // --- next meeting pill (top bar) -------------------------------------------
  // Data comes from the main process (calendar service, iCal feed).

  let meeting = null;
  let pill = null;
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function pillContent(m) {
    if (m.ongoing) return { label: 'Now', text: `${m.title} · until ${fmtTime(m.end)}` };
    const mins = Math.round((m.start - Date.now()) / 60000);
    return { label: '', text: mins < 60 ? `${m.title} · in ${Math.max(mins, 1)} min` : `${m.title} · ${fmtTime(m.start)}` };
  }

  function renderPill() {
    const anchor = document.querySelector(`[${TAG}="toprow"] div:has(> [aria-label^="Status:"])`);
    if (!meeting || !anchor) {
      pill?.remove();
      return;
    }
    if (!pill) {
      pill = el('button', { class: 'gslack-meeting', type: 'button' });
      pill.addEventListener('click', () => meeting?.meetUrl && bridge.openExternal(meeting.meetUrl));
    }
    const { label, text } = pillContent(meeting);
    const soon = !meeting.ongoing && meeting.start - Date.now() < 5 * 60000;
    // Only touch the DOM when something changed: the MutationObserver
    // calls back into refresh() → renderPill().
    const key = `${label}|${text}|${soon}|${!!meeting.meetUrl}`;
    if (pill.dataset.key !== key) {
      pill.dataset.key = key;
      pill.replaceChildren(
        el('span', { class: 'gslack-meeting-dot' }),
        label ? el('strong', { text: label }) : null,
        el('span', { class: 'gslack-meeting-text', text }),
      );
      pill.classList.toggle('ongoing', !!meeting.ongoing);
      pill.classList.toggle('soon', soon);
      pill.title = meeting.meetUrl ? 'Join Google Meet' : meeting.title;
    }
    if (pill.nextElementSibling !== anchor) anchor.parentElement.insertBefore(pill, anchor);
  }

  const offMeeting = bridge.onNextMeeting?.((m) => {
    meeting = m;
    renderPill();
  });
  const pillTimer = setInterval(renderPill, 30000);
  cleanups.push(() => offMeeting?.(), () => clearInterval(pillTimer), () => pill?.remove());

  // --- unread count ---------------------------------------------------------

  let lastUnread = -1;
  const reportUnread = () => {
    const label = document.querySelector(SEL.homeShortcut)?.getAttribute('aria-label') || '';
    const m = label.match(/(\d+) unread/);
    const n = m ? parseInt(m[1], 10) : entries().filter((e) => e.unread).length;
    if (n !== lastUnread) bridge.setUnread((lastUnread = n));
  };
  const refresh = () => { tagRegions(); replacePlaceholderAvatars(); renderPill(); reportUnread(); reportConversations(); };

  // Our own data-gslack* writes are not in attributeFilter, so no feedback loop.
  let pending = null;
  const observer = new MutationObserver(() => {
    if (!pending) pending = setTimeout(() => { pending = null; refresh(); }, 120);
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'class'] });
  cleanups.push(() => observer.disconnect(), () => clearTimeout(pending));
  refresh();

  window.__gslack = {
    openSwitcher,
    openGroup,
    markRead,
    previews: () => [...previews].map(([id, p]) => ({ id, ...p })),
    search,
    toggleTheme,
    entries,
    SEL,
    destroy() {
      closeSwitcher();
      cleanups.forEach((fn) => fn());
      // Let the next injection rescan messages (hot reload).
      document.querySelectorAll(`[${TAG}-msg]`).forEach((n) => n.removeAttribute(`${TAG}-msg`));
      document.querySelectorAll('[data-gslack-av-src]').forEach((n) => delete n.dataset.gslackAvSrc);
    },
  };
  bridge.log('gslack injected, entries:', entries().length);
})();
