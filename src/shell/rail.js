// Rail: switches views and shows badges pushed by the main process.
const api = window.gslackShell;
const items = [...document.querySelectorAll('.rail-item')];

// Off macOS: Ctrl shortcuts, no traffic lights (see rail.css).
if (api.platform !== 'darwin') {
  document.body.classList.add('no-mac');
  for (const item of items) item.title = item.title.replace('⌘', 'Ctrl+');
}

const fmtCount = (n) => (n > 99 ? '99+' : String(n));

function render(state) {
  if (!state) return;
  renderUpdate(state);
  for (const item of items) {
    const name = item.dataset.view;
    // The work item hub belongs with Jira.
    item.classList.toggle('active', state.active === name || (name === 'jira' && state.active === 'item'));
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

// A newer release is out (services/updates.js): link to its page.
const updateBtn = document.getElementById('update');
let updateUrl = null;
function renderUpdate(state) {
  const u = state?.update;
  updateUrl = u?.url || null;
  updateBtn.hidden = !u;
  if (u) {
    updateBtn.textContent = `v${u.version}`;
    updateBtn.title = `Workrail ${u.version} is available: open the download page`;
  }
}
updateBtn.addEventListener('click', () => updateUrl && api.openExternal(updateUrl));

api.onState(render);
api.getState().then(render);
