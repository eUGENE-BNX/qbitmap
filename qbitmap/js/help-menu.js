import { onDomReady } from './utils.js';

onDomReady(() => {
  const btn = document.getElementById('header-help-toggle');
  const menu = document.getElementById('header-help-menu');
  if (!btn || !menu) return;

  const close = () => {
    menu.classList.remove('open');
    btn.classList.remove('active');
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && !btn.contains(e.target)) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  menu.querySelectorAll('.header-help-item').forEach((item) => {
    item.addEventListener('click', close);
  });
});
