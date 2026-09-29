// Message chips: notifications from Chat / Gmail shown inside Workrail when
// it is in front but you are on another view. Click = open the conversation;
// they go away after a few seconds (paused while hovered).
const api = window.gslackShell;
const stack = document.getElementById('stack');
const SHOW_MS = 7000;
const MAX = 4;
const SOURCE = { chat: 'Chat', gmail: 'Mail', calendar: 'Calendar' };

// Tell main how tall the overlay must be (0 hides it).
function resize() {
  api.chipsSize(stack.children.length ? Math.ceil(stack.getBoundingClientRect().height) : 0);
}

function dismiss(card) {
  if (!card.isConnected || card.classList.contains('out')) return;
  card.classList.add('out');
  setTimeout(() => {
    card.remove();
    resize();
  }, 180);
}

function add(chip) {
  // Same notification again (e.g. edited message): replace it.
  stack.querySelector(`[data-id="${CSS.escape(chip.id)}"]`)?.remove();
  const initial = (chip.title.trim()[0] || '?').toUpperCase();
  const avatar = chip.icon ? el('img', { src: chip.icon, alt: '' }) : el('span', { class: 'ph', text: initial });
  avatar.addEventListener?.('error', () => avatar.replaceWith(el('span', { class: 'ph', text: initial })));
  const close = el('button', { class: 'chip-close', type: 'button', 'aria-label': 'Dismiss', text: '✕' });
  const card = el('div', { class: 'chip-card', role: 'button', tabindex: '0', 'data-id': chip.id, title: 'Open' },
    avatar,
    el('div', { class: 'chip-main' },
      el('div', { class: 'chip-title' }, document.createTextNode(chip.title || SOURCE[chip.source] || 'Notification'),
        el('span', { class: 'chip-source', text: SOURCE[chip.source] || '' })),
      chip.body ? el('div', { class: 'chip-body', text: chip.body }) : null),
    close);

  let timer = setTimeout(() => dismiss(card), SHOW_MS);
  card.addEventListener('mouseenter', () => clearTimeout(timer));
  card.addEventListener('mouseleave', () => { timer = setTimeout(() => dismiss(card), 2500); });
  card.addEventListener('click', () => {
    api.openChip(chip.source, chip.id);
    dismiss(card);
  });
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss(card);
  });

  stack.prepend(card); // column-reverse: first child sits at the bottom
  while (stack.children.length > MAX) stack.lastElementChild.remove();
  requestAnimationFrame(resize);
}

api.onChip(add);
new ResizeObserver(resize).observe(stack);
