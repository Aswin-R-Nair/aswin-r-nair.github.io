// Light/dark theme. Loaded synchronously in <head> so data-theme is set
// before first paint. Follows the system setting until the visitor picks one
// with the toggle; that choice is remembered in localStorage.
(function () {
  'use strict';

  const KEY = 'theme';
  const root = document.documentElement;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function store(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode etc. */ }
  }

  function current() {
    const s = stored();
    if (s === 'light' || s === 'dark') return s;
    return systemDark.matches ? 'dark' : 'light';
  }

  function apply(theme) {
    root.dataset.theme = theme;
    const btn = document.querySelector('.theme-toggle');
    if (btn) {
      const next = theme === 'dark' ? 'light' : 'dark';
      btn.setAttribute('aria-label', `Switch to ${next} mode`);
      btn.title = `Switch to ${next} mode`;
    }
  }

  apply(current());
  systemDark.addEventListener('change', () => { if (!stored()) apply(current()); });

  const SUN = '<svg class="theme-toggle__sun" viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4.5"/>' +
    '<path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8' +
    'M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
  const MOON = '<svg class="theme-toggle__moon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/></svg>';

  function addButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.innerHTML = SUN + MOON;
    btn.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      store(next);
      apply(next);
    });
    document.body.prepend(btn);
    apply(root.dataset.theme);
  }

  if (document.body) addButton();
  else document.addEventListener('DOMContentLoaded', addButton);
})();
