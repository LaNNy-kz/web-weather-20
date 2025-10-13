// Global toast helper (attaches showToast to window)
(function () {
  function ensureToastContainer() {
    if (!document.getElementById('toastContainer')) {
      const c = document.createElement('div');
      c.id = 'toastContainer';
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
  }
  window.showToast = function (msg, opts) {
    ensureToastContainer();
    const { type = 'info', duration = 3500 } = (opts || {});
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, duration);
  };
})();
