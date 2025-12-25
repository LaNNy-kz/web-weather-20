/* Utilities: debounce, cache, formatters */
window.debounce = (fn, wait = 400) => {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
};

const LS = window.localStorage;
window.cache = {
  get(key) {
    try {
      const raw = LS.getItem(key);
      if (!raw) return null;
      const { payload, exp } = JSON.parse(raw);
      if (Date.now() > exp) { LS.removeItem(key); return null; }
      return payload;
    } catch { return null; }
  },
  set(key, payload, ttlMs = 5 * 60 * 1000) {
    const exp = Date.now() + ttlMs;
    LS.setItem(key, JSON.stringify({ payload, exp }));
  }
};

window.fmt = {
  tempKtoC: (k) => Math.round(k - 273.15),
  wind: (ms) => `${(ms*3.6).toFixed(0)} km/h`,
  pressure: (hPa) => `${(hPa).toFixed(0)} hPa`,
  timeHM: (ts, tzOffsetSec=0) => {
    const d = new Date((ts + tzOffsetSec) * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },
  dayShort: (ts, tzOffsetSec=0) => {
    const d = new Date((ts + tzOffsetSec) * 1000);
    return d.toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit' });
  }
};
