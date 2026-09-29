// Injected into every Google view (Chat, Gmail, Calendar) on dom-ready.
//
// 1. Visibility: Workrail keeps these pages "visible" even when you are on
//    another view, so Chat only plays a sound instead of notifying. Main
//    tells each page whether it is really looked at, and the page's
//    visibility / focus APIs follow that.
// 2. Notifications: every page notification is handed to Workrail, which
//    decides when it arrives: an in-app chip (Workrail in front, another
//    view), a native notification (Workrail in the background), or nothing
//    (you are on this view). A click brings the window back on this view
//    and lets the page react (open the conversation).
(() => {
  if (window.__gslackNotifPatched) return;
  window.__gslackNotifPatched = true;
  const bridge = window.gslack;
  if (!bridge) return;

  // --- visibility -----------------------------------------------------------

  let hidden = false;
  const realHasFocus = Document.prototype.hasFocus;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.hasFocus = () => !hidden && realHasFocus.call(document);

  bridge.onVisibility?.((v) => {
    if (v.hidden === hidden) return;
    hidden = v.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(hidden ? 'blur' : 'focus'));
  });
  // Ask where we stand now that we listen (the page may load after main's
  // last update).
  bridge.requestVisibility?.();

  // --- notifications ----------------------------------------------------------

  const Native = window.Notification;
  const chips = new Map(); // id → stand-in notification (chip or native)
  let seq = 0;

  // Behaves like a Notification for the page (events, close()); Workrail
  // shows it as a chip or a native notification.
  class ChipNotification extends EventTarget {
    constructor(title, options = {}) {
      super();
      this.title = String(title || '');
      this.body = String(options.body || '');
      this.icon = options.icon || '';
      this.tag = options.tag || '';
      this.data = options.data ?? null;
      this.onclick = null;
      this.onclose = null;
      this.onshow = null;
      this.onerror = null;
      this.id = `n${Date.now()}-${++seq}`;
      chips.set(this.id, this);
      // tag / data name the conversation (space/…, dm/…) for Home's feed.
      let data = '';
      try {
        data = JSON.stringify(this.data ?? null).slice(0, 4000);
      } catch {
        // not serialisable
      }
      bridge.showChip({ id: this.id, title: this.title, body: this.body, icon: this.icon, tag: String(this.tag).slice(0, 300), data });
      setTimeout(() => this.#fire('show'), 0);
      // Forget it after a while: the chip is gone by then.
      setTimeout(() => chips.delete(this.id), 5 * 60 * 1000);
    }

    #fire(type) {
      const e = new Event(type, { cancelable: true });
      this.dispatchEvent(e);
      this[`on${type}`]?.call(this, e);
    }

    click() {
      this.#fire('click');
    }

    close() {
      if (chips.delete(this.id)) this.#fire('close');
    }
  }

  bridge.onChipClick?.((id) => {
    const n = chips.get(id);
    if (!n) return;
    n.click();
    n.close();
  });

  if (Native) {
    const Patched = function (title, options) {
      return new ChipNotification(title, options);
    };
    Patched.prototype = Native.prototype;
    Object.defineProperty(Patched, 'permission', { get: () => Native.permission });
    Patched.requestPermission = Native.requestPermission.bind(Native);
    Object.defineProperty(Patched, 'maxActions', { get: () => Native.maxActions || 0 });
    window.Notification = Patched;
  }

  // Service-worker notifications are unreliable in Electron: show them from
  // the page instead (same routing as above).
  const proto = window.ServiceWorkerRegistration?.prototype;
  if (proto?.showNotification) {
    proto.showNotification = function (title, options = {}) {
      const { actions, ...rest } = options;
      new window.Notification(title, rest);
      return Promise.resolve();
    };
  }
})();
