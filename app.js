/* Main application logic. Works with OpenWeather (geocoding + current + forecast + air_pollution). */
// Utilities are loaded via script tag and available as window.debounce, window.cache, window.fmt

const el = (id) => document.getElementById(id);
const HAS_WEATHER_UI = !!document.getElementById('current');
const q = el('q');
const suggestions = el('suggestions');
const useLocationBtn = el('useLocation');
const toggleTheme = el('toggleTheme');
const favToggle = el('favToggle');

// New sidebar and mobile menu elements
const sidebar = el('sidebar');
const sidebarToggle = el('sidebarToggle');
const mobileMenuBtn = el('mobileMenuBtn');


function fetchWithTimeout(resource, options = {}) {
  const { timeout = 5000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(resource, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

const state = {
  units: 'metric', // we convert Kelvin -> C manually for compatibility
  lang: 'en', // default language
};

function getKey() {
  const key = window.CONFIG?.OPENWEATHER_KEY;
  if (!key || key === 'YOUR_NEW_KEY_HERE') {
    setStatus('Missing OpenWeather API key. Create `config.js` with window.CONFIG = { OPENWEATHER_KEY: "fdea3b8ab607f535b3fa21bdf9d2b899" }', 'error');
    throw new Error('Missing API key');
  }
  return key;
}

function setTheme(light) {
  document.body.classList.toggle('light', !!light);
  localStorage.setItem('theme', light ? 'light' : 'dark');
}
(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) setTheme(saved === 'light');
  else setTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
})();
toggleTheme.addEventListener('click', () => setTheme(!document.body.classList.contains('light')));

// Provide a fallback global setter for header UI (name + avatar) so pages that
// don't include profile.js (like index.html) still show the user's avatar/name.
if (!window.setAuthUI) {
  window.setAuthUI = function () {
    try {
      const sess = JSON.parse(localStorage.getItem('session') || 'null');
      const headerAvatar = document.getElementById('headerAvatar');
      const profileBtn = document.getElementById('profileBtn');
      if (!sess) {
        if (headerAvatar) headerAvatar.style.display = 'none';
        if (profileBtn) profileBtn.textContent = 'Guest';
        return;
      }
      const users = JSON.parse(localStorage.getItem('users') || '[]');
      const user = users.find(u => u.email === sess.email) || { name: sess.name, email: sess.email };
      if (profileBtn) profileBtn.textContent = user.name || 'Account';
      if (headerAvatar) {
        if (user.avatar) { headerAvatar.src = user.avatar; headerAvatar.style.display = 'inline-block'; }
        else { headerAvatar.removeAttribute('src'); headerAvatar.style.display = 'none'; }
      }
    } catch (e) { /* ignore */ }
  };
}

// Initialize header UI on load
try { window.setAuthUI(); } catch (e) {}

function setStatus(msg, type='info') {
  const box = el('status');
  if (!box) return;
  box.textContent = msg || '';
  box.className = 'status ' + type;
  if (!msg) box.removeAttribute('class');
}

async function geocode(city) {
  const key = getKey();
  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=5&appid=${key}`;
  const ckey = `geocode:${city}`;
  const cached = window.cache.get(ckey);
  if (cached) return cached;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Geocoding error');
  const data = await r.json();
  window.cache.set(ckey, data, 24 * 60 * 60 * 1000);
  return data;
}



async function getWeather(lat, lon) {
  const key = getKey();
  const ckey = `weather2:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = window.cache.get(ckey);
  if (cached) return cached;

  // First fetch current (shows faster), then load forecast and AQI in background
  const currentRes = await fetchWithTimeout(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&lang=${state.lang}&appid=${key}`, { timeout: 6000 });
  if (!currentRes.ok) {
    if (currentRes.status === 401) setStatus('OpenWeather API key invalid or unauthorized', 'error');
    throw new Error('Weather API (current)');
  }
  const current = await currentRes.json();

  // Parallel: forecast (may take longer), AQI will be fetched later
  const forecastP = fetchWithTimeout(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&lang=${state.lang}&appid=${key}`, { timeout: 8000 })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
  const airP = fetchWithTimeout(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${key}`, { timeout: 5000 })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);

  const payload = { current, forecast: await forecastP, air: null };
  window.cache.set(ckey, payload, 3 * 60 * 1000);

  // Return without AQI so UI can render immediately; AQI will be applied when ready
  airP.then(air => {
    const updated = { ...payload, air };
    window.cache.set(ckey, updated, 3 * 60 * 1000);
    // if we're still on this location — redraw AQI
    try { renderAQI(updated); } catch {}
  });

  return payload;
}

function renderCurrent(placeName, w) {
  if (!HAS_WEATHER_UI) return;
  const { current } = w;
  el('place').textContent = placeName || `${current.name ?? ''}${current.sys?.country ? ', ' + current.sys.country : ''}`;
  // Update breadcrumb
  const breadcrumbPlace = el('breadcrumbPlace');
  if (breadcrumbPlace) {
    breadcrumbPlace.textContent = placeName || `${current.name ?? ''}${current.sys?.country ? ', ' + current.sys.country : ''}`;
  }
  el('updated').textContent = new Date().toLocaleString();

  const tzOffset = current.timezone ?? 0;
  el('temp').textContent = `${window.fmt.tempKtoC(current.main.temp)}°`;
  el('feels').textContent = `${window.fmt.tempKtoC(current.main.feels_like)}°`;
  el('wind').textContent = window.fmt.wind(current.wind.speed);
  el('humidity').textContent = `${current.main.humidity}%`;
  el('pressure').textContent = window.fmt.pressure(current.main.pressure);
  el('desc').textContent = current.weather?.[0]?.description ?? '—';

  const icon = current.weather?.[0]?.icon;
  const iconEl = document.getElementById('icon');
  if (icon) {
    iconEl.src = `https://openweathermap.org/img/wn/${icon}@2x.png`;
    iconEl.width = 100; iconEl.height = 100;
    iconEl.style.opacity = '1';
  } else {
    iconEl.removeAttribute('src'); iconEl.style.opacity = '0';
  }

  document.querySelector('.weather-main').classList.remove('skeleton');

  // Sync favorite toggle state
  try {
    const cityTitle = el('place').textContent.trim();
    const favs = JSON.parse(localStorage.getItem('favorites') || '[]');
    const on = favs.includes(cityTitle);
    if (favToggle) {
      favToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      favToggle.textContent = on ? '★' : '☆';
      favToggle.title = on ? 'Remove from favorites' : 'Add to favorites';
    }
  } catch {}
}

function renderHourly(w) {
  if (!HAS_WEATHER_UI) return;
  const root = el('hourly');
  root.innerHTML = '';
  const list = w.forecast?.list ?? [];
  const tzOffset = w.current?.timezone ?? 0;
  list.slice(0, 8).forEach(item => {
    const div = document.createElement('div');
    div.className = 'tile';
    const icon = item.weather?.[0]?.icon;
    div.innerHTML = `
      <div class="s">${window.fmt.timeHM(item.dt, tzOffset)}</div>
      <img src="https://openweathermap.org/img/wn/${icon}@2x.png" alt="" width="50" height="50" />
      <div class="t">${window.fmt.tempKtoC(item.main.temp)}°</div>
    `;
    root.appendChild(div);
  });
  root.classList.remove('skeleton');
  // Draw hourly chart if canvas exists
  try {
    const canvas = document.getElementById('hourlyChart');
    if (canvas && list.length) {
      renderHourlyChart(canvas, list.slice(0, 24), tzOffset);
    }
  } catch (e) { console.warn('Chart render failed', e); }
}

// Simple canvas line chart for hourly temperatures (expects forecast.list items)
function renderHourlyChart(canvas, items, tzOffset = 0) {
  if (!canvas) return;
  // store latest data on the canvas element for redrawing on resize
  try { canvas._chartData = { items, tzOffset }; } catch {}
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const temps = items.map(it => window.fmt.tempKtoC(it.main.temp));
  const times = items.map(it => window.fmt.timeHM(it.dt, tzOffset));
  const padding = { l: 36, r: 12, t: 12, b: 24 };
  const plotW = w - padding.l - padding.r;
  const plotH = h - padding.t - padding.b;
  const minT = Math.min(...temps);
  const maxT = Math.max(...temps);
  const range = Math.max(1, maxT - minT);

  // map data to coords
  const points = temps.map((t, i) => {
    const x = padding.l + (i / Math.max(1, temps.length - 1)) * plotW;
    const y = padding.t + (1 - (t - minT) / range) * plotH;
    return { x, y, t, label: times[i] };
  });

  // draw area fill
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length-1].x, padding.t + plotH);
  ctx.lineTo(points[0].x, padding.t + plotH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padding.t, 0, padding.t + plotH);
  grad.addColorStop(0, 'rgba(77,163,255,0.28)');
  grad.addColorStop(1, 'rgba(77,163,255,0.04)');
  ctx.fillStyle = grad;
  ctx.fill();

  // draw line
  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#4da3ff';
  ctx.moveTo(points[0].x, points[0].y);
  for (let p of points) ctx.lineTo(p.x, p.y);
  ctx.stroke();

  // draw points
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#2b6fab';
  points.forEach(p => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  });

  // y-axis labels (min/max)
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(maxT + '°', padding.l - 8, padding.t + 6);
  ctx.fillText(minT + '°', padding.l - 8, padding.t + plotH - 6);

  // x-axis labels
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(200,200,200,0.9)';
  const step = Math.ceil(points.length / 6);
  points.forEach((p, i) => {
    if (i % step === 0 || i === points.length - 1) {
      ctx.fillText(p.label, p.x, padding.t + plotH + 6);
    }
  });
}

// Redraw chart on resize / orientation change (debounced)
(function setupChartResize() {
  let t;
  function redraw() {
    const c = document.getElementById('hourlyChart');
    if (!c || !c._chartData) return;
    try { renderHourlyChart(c, c._chartData.items, c._chartData.tzOffset); } catch (e) { console.warn('Chart redraw failed', e); }
  }
  const handler = () => { clearTimeout(t); t = setTimeout(redraw, 200); };
  window.addEventListener('resize', handler);
  window.addEventListener('orientationchange', handler);
})();

function renderDaily(w) {
  if (!HAS_WEATHER_UI) return;
  const root = el('daily'); root.innerHTML = '';
  // group by date (take midday as the day's representative)
  const byDate = new Map();
  for (const item of (w.forecast?.list ?? [])) {
    const d = new Date(item.dt * 1000);
    const key = d.toISOString().slice(0,10);
    const hour = d.getUTCHours();
    const prev = byDate.get(key);
  // choose the "mid" hours (12:00–15:00) to represent the day
    if (!prev || Math.abs(hour - 13) < Math.abs(prev.hour - 13)) {
      byDate.set(key, { hour, item });
    }
  }
  [...byDate.values()].slice(0,7).forEach(({ item }) => {
    const div = document.createElement('div');
    div.className = 'tile';
    const d = new Date(item.dt * 1000);
    const day = d.toLocaleDateString('ru-RU', { weekday: 'short', day: '2-digit', month: 'short' });
    const icon = item.weather?.[0]?.icon;
    div.innerHTML = `
      <div class="s">${day}</div>
      <img src="https://openweathermap.org/img/wn/${icon}@2x.png" width="50" height="50" alt="" />
      <div class="t">${window.fmt.tempKtoC(item.main.temp)}°</div>
    `;
    root.appendChild(div);
  });
  root.classList.remove('skeleton');
}

function renderAQI(w) {
  if (!HAS_WEATHER_UI) return;
  const box = el('aqi');
  box.classList.remove('skeleton');
  const aqi = w?.air?.list?.[0]?.main?.aqi; // 1..5
  if (!aqi) { box.textContent = 'No data'; return; }
  const map = {
    1: { label: 'Good', cls: 'good' },
    2: { label: 'Moderate', cls: 'moderate' },
    3: { label: 'Unhealthy (sensitive)', cls: 'unhealthy' },
    4: { label: 'Unhealthy', cls: 'unhealthy' },
    5: { label: 'Very unhealthy', cls: 'unhealthy' },
  };
  const { label, cls } = map[aqi];
  box.innerHTML = `<span>Index: <b>${aqi}</b></span> <span class="badge ${cls}">${label}</span>`;
}


async function loadByCoords(lat, lon, placeOverride) {
  try {
    // Восстанавливаем язык из localStorage или используем текущий
    state.lang = localStorage.getItem('weatherLang') || state.lang;
    setStatus(state.lang === 'ru' ? 'Загрузка…' : 'Loading…');
    const w = await getWeather(lat, lon);
    renderCurrent(placeOverride, w);
    if (w.forecast) {
      renderHourly(w);
      renderDaily(w);
    } else {
    // If forecast wasn't ready yet, fetch it separately and render when available
      setTimeout(async () => {
        try {
          const key = getKey();
          const r = await fetchWithTimeout(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${key}`, { timeout: 8000 });
          if (r.ok) {
            w.forecast = await r.json();
            renderHourly(w);
            renderDaily(w);
          }
        } catch {}
      }, 0);
    }
  renderAQI(w); // will show "No data" until AQI loads
    setStatus('');
  } catch (e) {
    console.error(e);
  setStatus('Failed to retrieve data. Check API key or network.', 'error');
  }
}

async function onSearchSubmit(city) {
  if (!HAS_WEATHER_UI) { window.location.href = `index.html#q=${encodeURIComponent(city)}`; return; }
  const list = await geocode(city);
  if (!list.length) return setStatus('City not found', 'error');
  const { lat, lon, local_names, name, country, state } = list[0];
  
  // Определяем язык ввода
  const isRussianInput = /[а-яё]/i.test(city);
  state.lang = isRussianInput ? 'ru' : 'en';
  
  // Формируем название места в зависимости от языка
  const place = isRussianInput ? 
    (local_names?.ru || `${name}${state ? ', '+state : ''}, ${country}`) : 
    `${name}${state ? ', '+state : ''}, ${country}`;
  
  localStorage.setItem('lastCity', place);
  localStorage.setItem('weatherLang', state.lang);
  loadByCoords(lat, lon, place);
}

q.addEventListener('input', window.debounce(async () => {
  const val = q.value.trim();
  if (val.length < 2) { suggestions.classList.remove('show'); return; }
  try {
    const res = await geocode(val);
    // Группируем города по имени (игнорируя регистр)
    const groupedCities = new Map();
    
    res.forEach(loc => {
      const baseNameLower = loc.name.toLowerCase();
      const isRussianInput = /[а-яё]/i.test(val);
      const displayName = isRussianInput ? (loc.local_names?.ru || loc.name) : loc.name;
      
      if (!groupedCities.has(baseNameLower) || 
          (isRussianInput && loc.local_names?.ru && !groupedCities.get(baseNameLower).local_names?.ru)) {
        groupedCities.set(baseNameLower, loc);
      }
    });

    const sortEl = document.getElementById('sortCities');
    const order = sortEl ? sortEl.value : 'asc';
    const collator = new Intl.Collator('ru-RU');
    const sorted = [...groupedCities.values()].sort((a, b) => {
      const nameA = (a.local_names?.ru || a.name || '').toString();
      const nameB = (b.local_names?.ru || b.name || '').toString();
      const cmp = collator.compare(nameA, nameB);
      return order === 'desc' ? -cmp : cmp;
    });

    suggestions.innerHTML = '';
    sorted.forEach(loc => {
      const btn = document.createElement('button');
      const isRussianInput = /[а-яё]/i.test(val);
      const title = isRussianInput ? 
        (loc.local_names?.ru || `${loc.name}${loc.state ? ', '+loc.state : ''}, ${loc.country}`) :
        `${loc.name}${loc.state ? ', '+loc.state : ''}, ${loc.country}`;
      btn.textContent = title;
      btn.addEventListener('click', () => {
        if (!HAS_WEATHER_UI) { window.location.href = `index.html#q=${encodeURIComponent(title)}`; return; }
        suggestions.classList.remove('show');
        q.value = title;
        onSearchSubmit(title);
      });
      suggestions.appendChild(btn);
    });
    suggestions.classList.toggle('show', res.length > 0);
  } catch { suggestions.classList.remove('show'); }
}, 300));

// Re-paint suggestions on sort order change, if sorter exists
(function () {
  const sortEl = document.getElementById('sortCities');
  if (sortEl && !sortEl.dataset.bound) {
    sortEl.dataset.bound = '1';
    sortEl.addEventListener('change', () => {
      const val = q.value.trim();
      if (val.length >= 2) {
        q.dispatchEvent(new Event('input'));
      }
    });
  }
})();

useLocationBtn.addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Geolocation not supported', 'error');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      loadByCoords(latitude, longitude);
    },
  () => setStatus('Geolocation access denied', 'error'),
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

// Favorites toggle logic (sync with profile favorites list)
if (favToggle && HAS_WEATHER_UI) {
  if (!favToggle.dataset.bound) {
    favToggle.dataset.bound = '1';
    favToggle.addEventListener('click', () => {
      const title = (document.getElementById('place')?.textContent || '').trim();
      if (!title) return;
      const list = JSON.parse(localStorage.getItem('favorites') || '[]');
      const idx = list.indexOf(title);
      if (idx >= 0) list.splice(idx, 1); else list.push(title);
      localStorage.setItem('favorites', JSON.stringify(list));
      const on = list.includes(title);
      favToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      favToggle.textContent = on ? '★' : '☆';
      favToggle.title = on ? 'Remove from favorites' : 'Add to favorites';
    });
  }
}

(function () {
  // Start: if there is a last saved location — load from cache
  (async function bootstrap() {
  if (!HAS_WEATHER_UI) return;
  const hash = decodeURIComponent(location.hash || '');
  if (hash.startsWith('#q=')) {
    const city = hash.slice(3);
    q.value = city;
    onSearchSubmit(city);
    return;
  }
  const saved = localStorage.getItem('lastCity');
  if (saved) onSearchSubmit(saved);
  else if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              (pos) => { const { latitude, longitude } = pos.coords; loadByCoords(latitude, longitude); },
              () => setStatus('Geolocation access denied', 'error'),
              { enableHighAccuracy: true, timeout: 8000 }
            );
          }
})();

})();

// ====== AUTH UI STATE SYNC ======
(function () {
  // Ensure global Auth API exists
  async function sha256(text) {
    if (window.crypto?.subtle) {
      const enc = new TextEncoder().encode(text);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
    }
    return 'plain:' + text;
  }
  if (!window.Auth) {
    window.Auth = {
      key: 'users',
      sessionKey: 'session',
      _users() { return JSON.parse(localStorage.getItem(this.key) || '[]'); },
      _save(users) { localStorage.setItem(this.key, JSON.stringify(users)); },
      async register({ name, email, password }) {
        email = email.trim().toLowerCase();
        const users = this._users();
        if (users.some(u => u.email === email)) throw new Error('User already exists');
        const hash = await sha256(password);
        users.push({ name, email, hash, createdAt: Date.now() });
        this._save(users);
        localStorage.setItem(this.sessionKey, JSON.stringify({ email, name }));
      },
      async login({ email, password }) {
        email = email.trim().toLowerCase();
        const user = this._users().find(u => u.email === email);
        if (!user) throw new Error('Invalid email or password');
        const hash = await sha256(password);
        if (user.hash !== hash) throw new Error('Invalid email or password');
        localStorage.setItem(this.sessionKey, JSON.stringify({ email, name: user.name }));
      },
      logout() { localStorage.removeItem(this.sessionKey); },
      current() { return JSON.parse(localStorage.getItem(this.sessionKey) || 'null'); }
    };
  }

  // Unified UI update
  function setAuthUI() {
    const cur = window.Auth.current();
    const profileBtn = document.getElementById('profileBtn');
    const logout = document.getElementById('logout');
    const openAuth = document.getElementById('openAuth');
    const openAuth2 = document.getElementById('openAuth2');
    const openAuthMobile = document.getElementById('openAuthMobile');
    const authBtns = [openAuth, openAuth2, openAuthMobile].filter(Boolean);

    if (cur) {
      if (profileBtn) profileBtn.textContent = cur.name || cur.email;
      if (logout) logout.hidden = false;
      authBtns.forEach(b => (b.hidden = true));
      document.body.dataset.auth = 'on';
    } else {
      if (profileBtn) profileBtn.textContent = 'Guest';
      if (logout) logout.hidden = true;
      authBtns.forEach(b => (b.hidden = false));
      document.body.dataset.auth = 'off';
    }
  }

  // Modal focus management: focus first input when modal opens and close on Escape.
  function setupModalFocus() {
    const modal = document.getElementById('authModal');
    if (!modal) return;
    // When modal is opened (class .show toggled), focus first input inside
    const observer = new MutationObserver(() => {
      const isOpen = modal.classList.contains('show');
      if (isOpen) {
        const firstInput = modal.querySelector('input, button, [tabindex]');
        if (firstInput) firstInput.focus();
        document.body.classList.add('modal-open');
      } else {
        document.body.classList.remove('modal-open');
      }
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (modal.classList.contains('show')) {
          modal.classList.remove('show');
          modal.setAttribute('aria-hidden', 'true');
        }
      }
    });
  }
  try { setupModalFocus(); } catch {}

  // Guarded binding
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  if (loginForm && !loginForm.dataset.bound) {
    loginForm.dataset.bound = '1';
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = loginForm.email.value.trim();
      const password = loginForm.password.value;
      
      // Clear previous errors
      const errorEl = loginForm.querySelector('.error');
      if (errorEl) errorEl.textContent = '';
      
      if (!email || !password) {
        if (errorEl) errorEl.textContent = 'Please fill in all fields';
        return;
      }
      
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (errorEl) errorEl.textContent = 'Please enter a valid email address';
        return;
      }
      
      if (password.length < 6) {
        if (errorEl) errorEl.textContent = 'Password must be at least 6 characters';
        return;
      }
      
      try {
        // Add loading state
        loginForm.classList.add('loading');
        const submitBtn = loginForm.querySelector('.btn-primary');
        const originalText = submitBtn.textContent;
        submitBtn.textContent = 'Signing in...';
        
        await window.Auth.login({ email, password });
        setAuthUI();
        
        // close modal
        document.querySelectorAll('[data-close="authModal"]').forEach(el => el.click());
        if (window.showToast) window.showToast('Welcome back!', { type: 'success' });
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message || 'Login failed';
      } finally {
        // Remove loading state
        loginForm.classList.remove('loading');
        const submitBtn = loginForm.querySelector('.btn-primary');
        submitBtn.textContent = '🚀 Sign in';
      }
    });
  }
  if (registerForm && !registerForm.dataset.bound) {
    registerForm.dataset.bound = '1';
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = registerForm.name.value.trim();
      const email = registerForm.email.value.trim();
      const password = registerForm.password.value;
      const confirm = registerForm.confirm.value;
      
      // Clear previous errors
      const errorEl = registerForm.querySelector('.error');
      if (errorEl) errorEl.textContent = '';
      
      if (!name || name.length < 2) {
        if (errorEl) errorEl.textContent = 'Name must be at least 2 characters';
        return;
      }
      
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (errorEl) errorEl.textContent = 'Please enter a valid email address';
        return;
      }
      
      if (!password || password.length < 6) {
        if (errorEl) errorEl.textContent = 'Password must be at least 6 characters';
        return;
      }
      
      if (password !== confirm) {
        if (errorEl) errorEl.textContent = 'Passwords do not match';
        return;
      }
      
      try {
        // Add loading state
        registerForm.classList.add('loading');
        const submitBtn = registerForm.querySelector('.btn-primary');
        const originalText = submitBtn.textContent;
        submitBtn.textContent = 'Creating account...';
        
        await window.Auth.register({ name, email, password });
        setAuthUI();
        document.querySelectorAll('[data-close="authModal"]').forEach(el => el.click());
        if (window.showToast) window.showToast('Account created successfully!', { type: 'success' });
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message || 'Registration failed';
      } finally {
        // Remove loading state
        registerForm.classList.remove('loading');
        const submitBtn = registerForm.querySelector('.btn-primary');
        submitBtn.textContent = '✨ Create account';
      }
    });
  }

  // Logout
  const logoutBtn = document.getElementById('logout');
  if (logoutBtn && !logoutBtn.dataset.bound) {
    logoutBtn.dataset.bound = '1';
    logoutBtn.addEventListener('click', () => { window.Auth.logout(); setAuthUI(); });
  }

  // Initial paint
  try { setAuthUI(); } catch(e) {}
  // Expose to other parts
  window.setAuthUI = setAuthUI;
})();


// === NAV & AUTH UI HELPERS (safe add) ===
(function () {
  const $ = (id) => document.getElementById(id);

  // Dropdown "Menu ▾"
  const moreBtn = $('moreMenuBtn');
  const moreDrop = $('dropdownMore');
  if (moreBtn && moreDrop) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = moreDrop.classList.toggle('show');
      moreBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!moreDrop.contains(e.target) && e.target !== moreBtn) {
        moreDrop.classList.remove('show');
        moreBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Profile
  const profileBtn = $('profileBtn');
  const profileMenu = $('profileMenu');
  if (profileBtn && profileMenu) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = profileMenu.classList.toggle('show');
      profileBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!profileMenu.contains(e.target) && e.target !== profileBtn) {
        profileMenu.classList.remove('show');
        profileBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Burger / mobile menu
  const burger = $('burger');
  const mobileNav = $('mobileNav');
  if (burger && mobileNav) {
    burger.addEventListener('click', () => {
      const open = mobileNav.classList.toggle('open');
      burger.classList.toggle('active', open);
      burger.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('nav-open', open);
    });
  }

  // Authorization — show name/email in the profile button
  const session = localStorage.getItem('session');
  if (session && profileBtn) {
    try {
      const s = JSON.parse(session);
  profileBtn.textContent = s.name || s.email || 'Guest';
    } catch {}
  }
})();



// === Ensure Auth open/close + Clear Cache work (idempotent) ===
(function () {
  const authModal = document.getElementById('authModal');
  function activateLoginTab() {
    if (!authModal) return;
    const tabs = Array.from(authModal.querySelectorAll('.tab'));
    const login = authModal.querySelector('#loginForm');
    const register = authModal.querySelector('#registerForm');
    tabs.forEach(t => {
      const on = t.dataset.tab === 'login';
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    login?.classList.add('active');
    register?.classList.remove('active');
  }
  function openModal() {
    if (!authModal) return;
    authModal.classList.add('show');
    authModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    activateLoginTab();
  }
  function closeModal() {
    if (!authModal) return;
    authModal.classList.remove('show');
    authModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }

  // Bind openers
  ['openAuth','openAuth2','openAuthMobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', openModal);
    }
  });
  // Bind closers (X and backdrop)
  document.querySelectorAll('[data-close="authModal"]').forEach(el => {
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('click', closeModal);
    }
  });
  authModal?.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // Tabs: switch between login/register inside modal
  if (authModal && !authModal.dataset.tabsBound) {
    authModal.dataset.tabsBound = '1';
    authModal.addEventListener('click', (e) => {
      const tab = e.target.closest && e.target.closest('.tab');
      if (!tab) return;
      const isLogin = tab.dataset.tab === 'login';
      const tabs = Array.from(authModal.querySelectorAll('.tab'));
      const login = authModal.querySelector('#loginForm');
      const register = authModal.querySelector('#registerForm');
      tabs.forEach(t => {
        const on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      login?.classList.toggle('active', isLogin);
      register?.classList.toggle('active', !isLogin);
    });
  }

  // Clear cache button
  const clearCache = document.getElementById('clearCache');
  if (clearCache && !clearCache.dataset.bound) {
    clearCache.dataset.bound = '1';
    clearCache.addEventListener('click', () => {
      localStorage.clear();
      try { window.setAuthUI?.(); } catch(e) {}
  try { window.showToast?.('Cache cleared', { type: 'success' }); } catch { alert('Cache cleared'); }
    });
  }
})();

// === SIDEBAR & MOBILE MENU MANAGEMENT ===
(function() {
  // Sidebar toggle functionality
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }

  // Mobile menu toggle
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }

  // Close sidebar when clicking outside on mobile
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 1024) {
      if (!sidebar.contains(e.target) && !mobileMenuBtn.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    }
  });

  // Handle window resize
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1024) {
      sidebar.classList.remove('open');
    }
  });

  // View toggle for hourly forecast
  const viewToggles = document.querySelectorAll('.view-toggle');
  viewToggles.forEach(toggle => {
    toggle.addEventListener('click', () => {
      const card = toggle.closest('.dashboard-card');
      const view = toggle.dataset.view;
      
      // Update active state
      card.querySelectorAll('.view-toggle').forEach(t => t.classList.remove('active'));
      toggle.classList.add('active');
      
      // Toggle content visibility
      const hourlyList = card.querySelector('.hourly-list');
      const hourlyChart = card.querySelector('.hourly-chart');
      
      if (view === 'chart') {
        hourlyList.style.display = 'none';
        hourlyChart.style.display = 'block';
      } else {
        hourlyList.style.display = 'grid';
        hourlyChart.style.display = 'none';
      }
    });
  });

  // Enhanced search with better UX
  if (q) {
    q.addEventListener('focus', () => {
      if (window.innerWidth <= 1024) {
        sidebar.classList.add('open');
      }
    });
  }

  // Smooth scroll for better UX
  document.documentElement.style.scrollBehavior = 'smooth';
})();

// === ENHANCED WEATHER RENDERING ===
function renderCurrentEnhanced(placeName, w) {
  if (!HAS_WEATHER_UI) return;
  const { current } = w;
  
  // Update breadcrumb
  const breadcrumbLast = document.querySelector('.breadcrumb span:last-child');
  if (breadcrumbLast) {
    breadcrumbLast.textContent = placeName || `${current.name ?? ''}${current.sys?.country ? ', ' + current.sys.country : ''}`;
  }

  // Update hero section
  el('place').textContent = placeName || `${current.name ?? ''}${current.sys?.country ? ', ' + current.sys.country : ''}`;
  // Update breadcrumb
  const breadcrumbPlace = el('breadcrumbPlace');
  if (breadcrumbPlace) {
    breadcrumbPlace.textContent = placeName || `${current.name ?? ''}${current.sys?.country ? ', ' + current.sys.country : ''}`;
  }
  el('updated').textContent = new Date().toLocaleString();

  const tzOffset = current.timezone ?? 0;
  el('temp').textContent = `${window.fmt.tempKtoC(current.main.temp)}°`;
  el('feels').textContent = `${window.fmt.tempKtoC(current.main.feels_like)}°`;
  el('wind').textContent = window.fmt.wind(current.wind.speed);
  el('humidity').textContent = `${current.main.humidity}%`;
  el('pressure').textContent = window.fmt.pressure(current.main.pressure);
  el('desc').textContent = current.weather?.[0]?.description ?? '—';

  const icon = current.weather?.[0]?.icon;
  const iconEl = document.getElementById('icon');
  if (icon) {
    iconEl.src = `https://openweathermap.org/img/wn/${icon}@2x.png`;
    iconEl.width = 120; 
    iconEl.height = 120;
    iconEl.style.opacity = '1';
  } else {
    iconEl.removeAttribute('src'); 
    iconEl.style.opacity = '0';
  }

  // Remove skeleton class
  document.querySelector('.weather-main').classList.remove('skeleton');
  document.querySelector('.weather-details').classList.remove('skeleton');

  // Sync favorite toggle state
  try {
    const cityTitle = el('place').textContent.trim();
    const favs = JSON.parse(localStorage.getItem('favorites') || '[]');
    const on = favs.includes(cityTitle);
    if (favToggle) {
      favToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      favToggle.querySelector('.icon').textContent = on ? '⭐' : '⭐';
      favToggle.title = on ? 'Remove from favorites' : 'Add to favorites';
    }
  } catch {}
}

// Override the original renderCurrent function
const originalRenderCurrent = renderCurrent;
renderCurrent = renderCurrentEnhanced;

// === FAQ PAGE FUNCTIONALITY ===
(function() {
  // FAQ Category Tabs
  const categoryTabs = document.querySelectorAll('.category-tab');
  const faqSections = document.querySelectorAll('.faq-section');
  
  categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const category = tab.dataset.category;
      
      // Update active tab
      categoryTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Show corresponding section
      faqSections.forEach(section => {
        section.classList.remove('active');
        if (section.id === category) {
          section.classList.add('active');
        }
      });
    });
  });

  // FAQ Accordion
  const faqCards = document.querySelectorAll('.faq-card');
  
  faqCards.forEach(card => {
    const question = card.querySelector('.faq-question');
    const toggle = card.querySelector('.faq-toggle');
    
    question.addEventListener('click', () => {
      const isActive = card.classList.contains('active');
      
      // Close all other cards
      faqCards.forEach(c => c.classList.remove('active'));
      
      // Toggle current card
      if (!isActive) {
        card.classList.add('active');
      }
    });
  });
})();