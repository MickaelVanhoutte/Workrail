// Injected into every Google view (Chat, Gmail, Calendar) on dom-ready.
// Page notifications become native macOS ones via Electron. Wrap them so a
// click brings the (possibly hidden) window back, on the right view.
(() => {
  if (window.__gslackNotifPatched) return;
  window.__gslackNotifPatched = true;
  const bridge = window.gslack;
  if (!bridge) return;

  const Native = window.Notification;
  if (Native) {
    const Patched = function (title, options) {
      const n = new Native(title, options);
      n.addEventListener('click', () => { bridge.notificationClicked(); window.focus(); });
      bridge.notificationShown();
      return n;
    };
    Patched.prototype = Native.prototype;
    Object.defineProperty(Patched, 'permission', { get: () => Native.permission });
    Patched.requestPermission = Native.requestPermission.bind(Native);
    window.Notification = Patched;
  }

  // Service-worker notifications are unreliable in Electron: show them from
  // the page instead.
  const proto = window.ServiceWorkerRegistration?.prototype;
  if (proto?.showNotification) {
    proto.showNotification = function (title, options = {}) {
      const { actions, ...rest } = options;
      new window.Notification(title, rest);
      return Promise.resolve();
    };
  }
})();
