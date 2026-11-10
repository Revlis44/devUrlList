(() => {
  const storageKey = 'devurllist-theme';
  let theme = 'light';
  try { if (localStorage.getItem(storageKey) === 'dark') theme = 'dark'; } catch {}
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#101827' : '#3449d8';
    document.querySelectorAll('[data-set-theme]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.setTheme === theme));
    });
  }
  applyTheme();
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    document.querySelectorAll('[data-set-theme]').forEach(button => {
      button.addEventListener('click', () => {
        theme = button.dataset.setTheme;
        applyTheme();
        try { localStorage.setItem(storageKey, theme); } catch {}
      });
    });
  });
})();
