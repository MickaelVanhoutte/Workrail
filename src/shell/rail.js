// Rail: switches views and shows badges pushed by the main process.
const api = window.gslackShell;
const items = [...document.querySelectorAll('.rail-item')];

const fmtCount = (n) => (n > 99 ? '99+' : String(n));

function render(state) {
  if (!state) return;
  for (const item of items) {
    const name = item.dataset.view;
    item.classList.toggle('active', state.active === name);
    const badge = item.querySelector('.rail-badge');
    if (!badge) continue;
    const value = state.badges?.[name];
    const show = typeof value === 'number' ? value > 0 : !!value;
    badge.hidden = !show;
    if (show) badge.textContent = typeof value === 'number' ? fmtCount(value) : value;
    badge.classList.toggle('now', value === 'now');
  }
}

for (const item of items) {
  item.addEventListener('click', () => api.select(item.dataset.view));
}

api.onState(render);
api.getState().then(render);
