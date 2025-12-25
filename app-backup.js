/* Main application logic. Works with OpenWeather (geocoding + current + forecast + air_pollution). */
// Import moved to inline functions to avoid module issues

// Note: script is now type="module" which allows faster/module-level loading.

// === UTILITY FUNCTIONS (from utils.js) ===
const debounce = (fn, wait = 400) => {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
};

const LS = window.localStorage;
const cache = {
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

const fmt = {
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
};

function getKey() {
  const key = window.CONFIG?.OPENWEATHER_KEY;
  if (!key || key === 'YOUR_NEW_KEY_HERE') {
    console.error('API key not found or invalid');
    console.log('window.CONFIG:', window.CONFIG);
    setStatus('Missing OpenWeather API key. Create `config.js` with window.CONFIG = { OPENWEATHER_KEY: "YOUR_KEY" }', 'error');
    throw new Error('Missing API key');
  }
  console.log('API key loaded successfully:', key.substring(0, 8) + '...');
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
  if (!key) {
    console.error('API key not found');
    setStatus('API key not configured', 'error');
    throw new Error('API key not found');
  }
  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=5&appid=${key}`;
  const ckey = `geocode:${city}`;
  const cached = cache.get(ckey);
  if (cached) return cached;
  
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.error(`Geocoding API error: ${r.status} ${r.statusText}`);
      setStatus(`API error: ${r.status}`, 'error');
      throw new Error(`HTTP ${r.status}`);
    }
    const data = await r.json();
    if (!Array.isArray(data)) {
      console.error('Invalid geocoding response:', data);
      throw new Error('Invalid API response');
    }
    cache.set(ckey, data, 24 * 60 * 60 * 1000);
    return data;
  } catch (error) {
    console.error('Geocoding error:', error);
    setStatus('Failed to search locations', 'error');
    throw error;
  }
}



async function getWeather(lat, lon) {
  const key = getKey();
  if (!key) {
    console.error('API key not found');
    setStatus('API key not configured', 'error');
    throw new Error('API key not found');
  }
  const ckey = `weather2:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = cache.get(ckey);
  if (cached) return cached;

  try {
    // First fetch current (shows faster), then load forecast and AQI in background
    const currentRes = await fetchWithTimeout(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${key}`, { timeout: 6000 });
    if (!currentRes.ok) {
      console.error(`Weather API error: ${currentRes.status} ${currentRes.statusText}`);
      if (currentRes.status === 401) {
        setStatus('OpenWeather API key invalid or unauthorized', 'error');
        throw new Error('API key invalid');
      }
      if (currentRes.status === 429) {
        setStatus('API rate limit exceeded', 'error');
        throw new Error('Rate limit exceeded');
      }
      setStatus(`Weather API error: ${currentRes.status}`, 'error');
      throw new Error(`Weather API error: ${currentRes.status}`);
    }
    const current = await currentRes.json();
    if (!current || !current.main) {
      console.error('Invalid weather response:', current);
      throw new Error('Invalid weather data');
    }

    // Parallel: forecast (may take longer), AQI will be fetched later
    const forecastP = fetchWithTimeout(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${key}`, { timeout: 8000 })
      .then(r => r.ok ? r.json() : null)
      .catch(err => {
        console.warn('Forecast API error:', err);
        return null;
      });
    const airP = fetchWithTimeout(`https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${key}`, { timeout: 5000 })
      .then(r => r.ok ? r.json() : null)
      .catch(err => {
        console.warn('Air pollution API error:', err);
        return null;
      });

    const payload = { current, forecast: await forecastP, air: null };
    cache.set(ckey, payload, 3 * 60 * 1000);

    // Return without AQI so UI can render immediately; AQI will be applied when ready
    airP.then(air => {
      const updated = { ...payload, air };
      cache.set(ckey, updated, 3 * 60 * 1000);
      // if we're still on this location — redraw AQI
      try { renderAQI(updated); } catch {}
    });

    return payload;
  } catch (error) {
    console.error('Weather API error:', error);
    setStatus('Failed to load weather data', 'error');
    throw error;
  }
}

function renderCurrent(placeName, w) {
  if (!HAS_WEATHER_UI) return;
  const { current } = w;
  el('place').textContent = placeName || `${current.name ?? ''}${current.sys?.country ? ', ' + current.sys.country : ''}`;
  el('updated').textContent = new Date().toLocaleString();

  const tzOffset = current.timezone ?? 0;
  el('temp').textContent = `${fmt.tempKtoC(current.main.temp)}°`;
  el('feels').textContent = `${fmt.tempKtoC(current.main.feels_like)}°`;
  el('wind').textContent = fmt.wind(current.wind.speed);
  el('humidity').textContent = `${current.main.humidity}%`;
  el('pressure').textContent = fmt.pressure(current.main.pressure);
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

  document.querySelector('.current-wrap').classList.remove('skeleton');

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
      <div class="s">${fmt.timeHM(item.dt, tzOffset)}</div>
      <img src="https://openweathermap.org/img/wn/${icon}@2x.png" alt="" width="50" height="50" />
      <div class="t">${fmt.tempKtoC(item.main.temp)}°</div>
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

  const temps = items.map(it => fmt.tempKtoC(it.main.temp));
  const times = items.map(it => fmt.timeHM(it.dt, tzOffset));
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
      <div class="t">${fmt.tempKtoC(item.main.temp)}°</div>
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
  console.log('Loading weather for:', placeOverride, 'at', lat, lon);
  try {
    setStatus('Loading…');
    console.log('Fetching weather data...');
    const w = await getWeather(lat, lon);
    console.log('Weather data received:', w);
    
    console.log('Rendering current weather...');
    renderCurrent(placeOverride, w);
    
    if (w.forecast) {
      console.log('Rendering forecasts...');
      renderHourly(w);
      renderDaily(w);
    } else {
      console.log('Forecast not ready, fetching separately...');
      // If forecast wasn't ready yet, fetch it separately and render when available
      setTimeout(async () => {
        try {
          const key = getKey();
          const r = await fetchWithTimeout(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${key}`, { timeout: 8000 });
          if (r.ok) {
            w.forecast = await r.json();
            console.log('Forecast data received separately');
            renderHourly(w);
            renderDaily(w);
          }
        } catch (err) {
          console.error('Error fetching forecast separately:', err);
        }
      }, 0);
    }
    
    console.log('Rendering air quality...');
    renderAQI(w); // will show "No data" until AQI loads
    setStatus('');
    console.log('Weather data loaded successfully');
  } catch (e) {
    console.error('Error loading weather:', e);
    setStatus('Failed to retrieve data. Check API key or network.', 'error');
  }
}

async function onSearchSubmit(city) {
  if (!HAS_WEATHER_UI) { window.location.href = `index.html#q=${encodeURIComponent(city)}`; return; }
  const list = await geocode(city);
  if (!list.length) return setStatus('City not found', 'error');
  const { lat, lon, local_names, name, country, state } = list[0];
  const place = local_names?.ru || `${name}${state ? ', '+state : ''}, ${country}`;
  localStorage.setItem('lastCity', place);
  
  // Save to search history
  const searchHistory = JSON.parse(localStorage.getItem('lastSearches') || '[]');
  if (!searchHistory.includes(place)) {
    searchHistory.unshift(place);
    if (searchHistory.length > 10) searchHistory.pop(); // Keep only last 10
    localStorage.setItem('lastSearches', JSON.stringify(searchHistory));
  }
  
  loadByCoords(lat, lon, place);
}

q.addEventListener('input', debounce(async () => {
  const val = q.value.trim();
  if (val.length < 2) { suggestions.classList.remove('show'); return; }
  
  // Show search history first
  const searchHistory = JSON.parse(localStorage.getItem('lastSearches') || '[]');
  const historyMatches = searchHistory.filter(city => 
    city.toLowerCase().includes(val.toLowerCase())
  );
  
  if (historyMatches.length > 0 && val.length < 3) {
    suggestions.innerHTML = '';
    historyMatches.slice(0, 5).forEach(city => {
      const btn = document.createElement('button');
      btn.innerHTML = `<span style="color: var(--primary);">🕒</span> ${city}`;
      btn.addEventListener('click', () => {
        suggestions.classList.remove('show');
        q.value = city;
        onSearchSubmit(city);
      });
      suggestions.appendChild(btn);
    });
    suggestions.classList.add('show');
    return;
  }
  
  try {
    const res = await geocode(val);
    // sort suggestions when sorter exists
    const sortEl = document.getElementById('sortCities');
    const order = sortEl ? sortEl.value : 'asc';
    const collator = new Intl.Collator('ru-RU');
    const sorted = [...res].sort((a, b) => {
      const nameA = (a.local_names?.ru || a.name || '').toString();
      const nameB = (b.local_names?.ru || b.name || '').toString();
      const cmp = collator.compare(nameA, nameB);
      return order === 'desc' ? -cmp : cmp;
    });

    suggestions.innerHTML = '';
    sorted.forEach(loc => {
      const btn = document.createElement('button');
      const title = loc.local_names?.ru || `${loc.name}${loc.state ? ', '+loc.state : ''}, ${loc.country}`;
      btn.innerHTML = `<span style="color: var(--primary);">🔍</span> ${title}`;
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
  console.log('Initializing weather app...');
  const saved = localStorage.getItem('lastCity');
  if (saved) {
    console.log('Loading last city:', saved);
    onSearchSubmit(saved);
  } else if (navigator.geolocation) {
    console.log('No last city, trying geolocation...');
    navigator.geolocation.getCurrentPosition(
      (pos) => { 
        console.log('Location obtained:', pos.coords.latitude, pos.coords.longitude);
        loadByCoords(pos.coords.latitude, pos.coords.longitude, 'Your Location'); 
      },
      (err) => {
        console.log('Geolocation failed:', err);
        console.log('Falling back to London...');
        onSearchSubmit('London');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  } else {
    console.log('No geolocation, using London...');
    onSearchSubmit('London');
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
      // basic validation
      const email = loginForm.email.value.trim();
      const password = loginForm.password.value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6) {
        const err = loginForm.querySelector('.error'); if (err) err.textContent = 'Check email/password';
        return;
      }
      try {
        await window.Auth.login({ email, password });
        setAuthUI();
        // close modal if function exists
        document.querySelectorAll('[data-close="authModal"]').forEach(el => el.click());
      } catch (err) {
        const errEl = loginForm.querySelector('.error'); if (errEl) errEl.textContent = err.message;
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
      const err = registerForm.querySelector('.error');
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6 || password !== confirm) {
        if (err) err.textContent = 'Please fill the form correctly';
        return;
      }
      try {
        await window.Auth.register({ name, email, password });
        setAuthUI();
        document.querySelectorAll('[data-close="authModal"]').forEach(el => el.click());
      } catch (e2) {
        if (err) err.textContent = e2.message;
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
      if (!sidebar.contains(e.target) && e.target !== mobileMenuBtn) {
        sidebar.classList.remove('open');
      }
    }
  });

  // Close sidebar when clicking on nav items
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 1024) {
        sidebar.classList.remove('open');
      }
    });
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
  const breadcrumbPlace = document.querySelector('.breadcrumb span:last-child');
  if (breadcrumbPlace) {
    breadcrumbPlace.textContent = placeName || `${current.name ?? ''}${current.sys?.country ? ', ' + current.sys.country : ''}`;
  }

  // Update hero section
  el('place').textContent = placeName || `${current.name ?? ''}${current.sys?.country ? ', ' + current.sys.country : ''}`;
  el('updated').textContent = new Date().toLocaleString();
  
  // Save update time for status indicator
  localStorage.setItem('lastWeatherUpdate', Date.now().toString());

  const tzOffset = current.timezone ?? 0;
  el('temp').textContent = `${fmt.tempKtoC(current.main.temp)}°`;
  el('feels').textContent = `${fmt.tempKtoC(current.main.feels_like)}°`;
  el('wind').textContent = fmt.wind(current.wind.speed);
  el('humidity').textContent = `${current.main.humidity}%`;
  el('pressure').textContent = fmt.pressure(current.main.pressure);
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

// === ENHANCED FAVORITES FUNCTIONALITY ===
(function() {
  // Enhanced favorite toggle
  if (favToggle) {
    favToggle.addEventListener('click', () => {
      const cityTitle = el('place').textContent.trim();
      if (!cityTitle || cityTitle === '—') {
        window.showToast?.('Please search for a city first', { type: 'warning' });
        return;
      }
      
      const favs = JSON.parse(localStorage.getItem('favorites') || '[]');
      const isFav = favs.includes(cityTitle);
      
      if (isFav) {
        const updatedFavs = favs.filter(c => c !== cityTitle);
        localStorage.setItem('favorites', JSON.stringify(updatedFavs));
        favToggle.setAttribute('aria-pressed', 'false');
        favToggle.title = 'Add to favorites';
        window.showToast?.('Removed from favorites', { type: 'info' });
      } else {
        favs.push(cityTitle);
        localStorage.setItem('favorites', JSON.stringify(favs));
        favToggle.setAttribute('aria-pressed', 'true');
        favToggle.title = 'Remove from favorites';
        window.showToast?.('Added to favorites!', { type: 'success' });
      }
      
      // Update counts if on profile page
      const favoritesCount = document.getElementById('favoritesCount');
      if (favoritesCount) {
        const updatedFavs = JSON.parse(localStorage.getItem('favorites') || '[]');
        favoritesCount.textContent = updatedFavs.length;
      }
    });
  }

  // Enhanced status indicator
  function updateStatusIndicator() {
    const statusEl = document.getElementById('status');
    if (!statusEl) return;
    
    const lastUpdate = localStorage.getItem('lastWeatherUpdate');
    const now = Date.now();
    
    if (!lastUpdate) {
      statusEl.textContent = '⚪';
      statusEl.title = 'No data loaded';
      return;
    }
    
    const timeDiff = now - parseInt(lastUpdate);
    const minutesAgo = Math.floor(timeDiff / 60000);
    
    if (minutesAgo < 5) {
      statusEl.textContent = '🟢';
      statusEl.title = `Data is fresh (${minutesAgo}m ago)`;
    } else if (minutesAgo < 30) {
      statusEl.textContent = '🟡';
      statusEl.title = `Data is recent (${minutesAgo}m ago)`;
    } else {
      statusEl.textContent = '🔴';
      statusEl.title = `Data is stale (${minutesAgo}m ago)`;
    }
  }

  // Update status every minute
  setInterval(updateStatusIndicator, 60000);
  updateStatusIndicator();
})();

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
        // Smooth scroll to question
        setTimeout(() => {
          question.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      }
    });
  });

  // Enhanced FAQ search functionality
  const faqSearchInput = document.querySelector('.faq-search input');
  if (faqSearchInput) {
    faqSearchInput.addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const allCards = document.querySelectorAll('.faq-card');
      
      allCards.forEach(card => {
        const question = card.querySelector('.faq-question h3').textContent.toLowerCase();
        const answer = card.querySelector('.faq-answer').textContent.toLowerCase();
        const matches = question.includes(searchTerm) || answer.includes(searchTerm);
        
        card.style.display = matches ? 'block' : 'none';
      });
    });
  }

  // FAQ keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Close all FAQ cards
      faqCards.forEach(card => card.classList.remove('active'));
    }
  });

  // FAQ analytics (track which questions are opened)
  faqCards.forEach(card => {
    card.addEventListener('click', () => {
      const question = card.querySelector('.faq-question h3').textContent;
      console.log(`FAQ opened: ${question}`);
      // You could send this to analytics service
    });
  });
})();

// === ENHANCED FUNCTIONALITY ===
(function() {
  // Clear cache functionality (consolidated)

  // Theme toggle functionality (consolidated)

  // Enhanced contact buttons functionality
  const contactBtns = document.querySelectorAll('.contact-btn');
  contactBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const text = btn.querySelector('span:last-child').textContent;
      if (text.includes('Email')) {
        // Copy email to clipboard
        navigator.clipboard.writeText('support@weatherpro.com').then(() => {
          window.showToast?.('Email copied to clipboard: support@weatherpro.com', { type: 'success' });
        }).catch(() => {
          window.showToast?.('Email support: support@weatherpro.com', { type: 'info' });
        });
      } else if (text.includes('Chat')) {
        window.showToast?.('Live chat coming soon! In the meantime, you can email us.', { type: 'info' });
      }
    });
  });

  // Enhanced search functionality
  const searchInput = document.getElementById('q');
  if (searchInput) {
    // Add search suggestions with keyboard navigation
    searchInput.addEventListener('keydown', (e) => {
      const suggestions = document.querySelector('.suggestions');
      if (suggestions && suggestions.classList.contains('show')) {
        const buttons = suggestions.querySelectorAll('button');
        const activeBtn = suggestions.querySelector('button:focus');
        
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (activeBtn && activeBtn.nextElementSibling) {
            activeBtn.nextElementSibling.focus();
          } else if (buttons.length > 0) {
            buttons[0].focus();
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (activeBtn && activeBtn.previousElementSibling) {
            activeBtn.previousElementSibling.focus();
          }
        } else if (e.key === 'Enter' && activeBtn) {
          e.preventDefault();
          activeBtn.click();
        }
      }
    });
  }

  // Enhanced location button
  const useLocationBtn = document.getElementById('useLocation');
  if (useLocationBtn) {
    useLocationBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        window.showToast?.('Geolocation is not supported by this browser', { type: 'error' });
        return;
      }
      
      window.showToast?.('Getting your location...', { type: 'info' });
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          loadByCoords(latitude, longitude, 'Your Location');
          window.showToast?.('Location found!', { type: 'success' });
        },
        (error) => {
          console.error('Geolocation error:', error);
          let message = 'Unable to get your location';
          switch(error.code) {
            case error.PERMISSION_DENIED:
              message = 'Location access denied. Please allow location access and try again.';
              break;
            case error.POSITION_UNAVAILABLE:
              message = 'Location information unavailable.';
              break;
            case error.TIMEOUT:
              message = 'Location request timed out.';
              break;
          }
          window.showToast?.(message, { type: 'error' });
        },
        { timeout: 10000, enableHighAccuracy: true }
      );
    });
  }

  // Avatar upload functionality (consolidated)

  // Profile form functionality
  const profileForm = document.getElementById('profileForm');
  if (profileForm) {
    profileForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const formData = new FormData(profileForm);
      const name = formData.get('name');
      const email = formData.get('email');
      
      // Basic validation
      if (!name || name.length < 2) {
        window.showToast?.('Name must be at least 2 characters', { type: 'error' });
        return;
      }
      
      if (!email || !email.includes('@')) {
        window.showToast?.('Please enter a valid email', { type: 'error' });
        return;
      }
      
      // Save to localStorage
      const userData = {
        name: name,
        email: email,
        avatar: localStorage.getItem('userAvatar') || ''
      };
      localStorage.setItem('userData', JSON.stringify(userData));
      
      // Update UI
      const userDisplayName = document.getElementById('userDisplayName');
      const userEmail = document.getElementById('userEmail');
      if (userDisplayName) userDisplayName.textContent = name;
      if (userEmail) userEmail.textContent = email;
      
      // Update sidebar user info
      const profileBtn = document.getElementById('profileBtn');
      if (profileBtn) profileBtn.textContent = name;
      
      window.showToast?.('Profile updated successfully!', { type: 'success' });
    });
  }

  // Load saved profile data
  const savedUserData = localStorage.getItem('userData');
  if (savedUserData) {
    try {
      const userData = JSON.parse(savedUserData);
      const userDisplayName = document.getElementById('userDisplayName');
      const userEmail = document.getElementById('userEmail');
      const pfName = document.getElementById('pfName');
      const pfEmail = document.getElementById('pfEmail');
      const profileBtn = document.getElementById('profileBtn');
      
      if (userDisplayName) userDisplayName.textContent = userData.name;
      if (userEmail) userEmail.textContent = userData.email;
      if (pfName) pfName.value = userData.name;
      if (pfEmail) pfEmail.value = userData.email;
      if (profileBtn) profileBtn.textContent = userData.name;
    } catch(e) {
      console.warn('Error loading user data:', e);
    }
  }

  // Load saved avatar
  const savedAvatar = localStorage.getItem('userAvatar');
  if (savedAvatar) {
    const headerAvatar = document.getElementById('headerAvatar');
    if (headerAvatar) {
      headerAvatar.src = savedAvatar;
      headerAvatar.style.display = 'block';
    }
  }

  // Favorites functionality
  const favAdd = document.getElementById('favAdd');
  const favCity = document.getElementById('favCity');
  const favorites = document.getElementById('favorites');
  
  if (favAdd && favCity && favorites) {
    favAdd.addEventListener('click', () => {
      const city = favCity.value.trim();
      if (city) {
        const favs = JSON.parse(localStorage.getItem('favorites') || '[]');
        if (!favs.includes(city)) {
          favs.push(city);
          localStorage.setItem('favorites', JSON.stringify(favs));
          renderFavorites();
          favCity.value = '';
          window.showToast?.('City added to favorites!', { type: 'success' });
        } else {
          window.showToast?.('City already in favorites!', { type: 'info' });
        }
      }
    });
    
    // Load favorites on page load
    renderFavorites();
  }

  function renderFavorites() {
    if (!favorites) return;
    const favs = JSON.parse(localStorage.getItem('favorites') || '[]');
    favorites.innerHTML = '';
    
    if (favs.length === 0) {
      favorites.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 2rem;">No favorite cities yet. Add some cities to see them here!</p>';
      return;
    }
    
    favs.forEach(city => {
      const favCard = document.createElement('div');
      favCard.className = 'favorite-card';
      favCard.innerHTML = `
        <div class="favorite-info">
          <div class="favorite-city">${city}</div>
          <div class="favorite-temp">Click to view weather</div>
        </div>
        <div class="favorite-actions">
          <button class="favorite-delete" data-city="${city}">🗑️</button>
        </div>
      `;
      
      // Add click to search functionality
      favCard.addEventListener('click', (e) => {
        if (!e.target.classList.contains('favorite-delete')) {
          if (q) {
            q.value = city;
            onSearchSubmit(city);
          }
        }
      });
      
      // Add delete functionality
      const deleteBtn = favCard.querySelector('.favorite-delete');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cityToRemove = deleteBtn.dataset.city;
        const updatedFavs = favs.filter(c => c !== cityToRemove);
        localStorage.setItem('favorites', JSON.stringify(updatedFavs));
        renderFavorites();
        window.showToast?.('City removed from favorites', { type: 'info' });
      });
      
      favorites.appendChild(favCard);
    });
  }

  // Update favorites count
  function updateFavoritesCount() {
    const favs = JSON.parse(localStorage.getItem('favorites') || '[]');
    const favoritesCount = document.getElementById('favoritesCount');
    if (favoritesCount) {
      favoritesCount.textContent = favs.length;
    }
  }
  
  // Update locations count
  function updateLocationsCount() {
    const locations = JSON.parse(localStorage.getItem('lastSearches') || '[]');
    const locationsCount = document.getElementById('locationsCount');
    if (locationsCount) {
      locationsCount.textContent = locations.length;
    }
  }

  // Initialize counts
  updateFavoritesCount();
  updateLocationsCount();

  // Test API button
  const testApiBtn = document.getElementById('testApi');
  if (testApiBtn) {
    testApiBtn.addEventListener('click', async () => {
      console.log('Testing API...');
      setStatus('Testing API...', 'loading');
      
      try {
        // Test API key
        const key = getKey();
        console.log('API key test passed');
        
        // Test geocoding
        console.log('Testing geocoding...');
        const geocodeResult = await geocode('London');
        console.log('Geocoding test passed:', geocodeResult);
        
        // Test weather API
        console.log('Testing weather API...');
        const weatherResult = await getWeather(51.5074, -0.1278); // London coordinates
        console.log('Weather API test passed:', weatherResult);
        
        setStatus('API test successful!', 'success');
        window.showToast?.('API is working correctly!', { type: 'success' });
        
        // Load London weather
        loadByCoords(51.5074, -0.1278, 'London, GB');
        
      } catch (error) {
        console.error('API test failed:', error);
        setStatus('API test failed: ' + error.message, 'error');
        window.showToast?.('API test failed: ' + error.message, { type: 'error' });
      }
    });
  }

  // Load Weather button
  const loadWeatherBtn = document.getElementById('loadWeather');
  if (loadWeatherBtn) {
    loadWeatherBtn.addEventListener('click', () => {
      console.log('Manual weather load triggered');
      setStatus('Loading weather...', 'loading');
      
      // Try to load London weather directly
      onSearchSubmit('London');
    });
  }

  // Enhanced profile functionality
  const profileBtns = document.querySelectorAll('.profile-btn, .auth-btn');
  profileBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const savedUserData = localStorage.getItem('userData');
      if (savedUserData) {
        try {
          const userData = JSON.parse(savedUserData);
          btn.textContent = userData.name;
        } catch(e) {
          console.warn('Error loading user data:', e);
        }
      }
    });
  });

  // Enhanced theme toggle with better feedback
  const themeToggle = document.getElementById('toggleTheme');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const isLight = document.body.classList.contains('light');
      setTheme(!isLight);
      const themeText = !isLight ? 'Light' : 'Dark';
      window.showToast?.(`Switched to ${themeText} theme`, { type: 'success' });
    });
  }

  // Enhanced clear cache with confirmation
  const clearCacheBtn = document.getElementById('clearCache');
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all data? This will remove your favorites, search history, and profile data.')) {
        localStorage.clear();
        try { 
          window.setAuthUI?.(); 
          window.showToast?.('All data cleared successfully', { type: 'success' });
          // Reload page to reset everything
          setTimeout(() => window.location.reload(), 1000);
        } catch(e) { 
          alert('Cache cleared successfully'); 
        }
      }
    });
  }

  // Enhanced avatar upload with validation
  const avatarFile = document.getElementById('avatarFile');
  if (avatarFile) {
    avatarFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        // Validate file size (max 2MB)
        if (file.size > 2 * 1024 * 1024) {
          window.showToast?.('File too large. Please choose an image smaller than 2MB.', { type: 'error' });
          return;
        }
        
        // Validate file type
        if (!file.type.startsWith('image/')) {
          window.showToast?.('Please select an image file.', { type: 'error' });
          return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
          const avatarPreview = document.getElementById('avatarPreview');
          const headerAvatar = document.getElementById('headerAvatar');
          
          if (avatarPreview) {
            avatarPreview.src = e.target.result;
            avatarPreview.style.display = 'block';
          }
          if (headerAvatar) {
            headerAvatar.src = e.target.result;
            headerAvatar.style.display = 'block';
          }
          
          // Save to localStorage
          localStorage.setItem('userAvatar', e.target.result);
          window.showToast?.('Avatar updated successfully!', { type: 'success' });
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // Enhanced favorites with better UX (consolidated)

  // Enhanced profile form with real-time validation (consolidated)

  // Enhanced error handling and recovery
  window.addEventListener('error', (e) => {
    console.error('Global error:', e);
    if (e.message.includes('API')) {
      window.showToast?.('API connection issue. Please check your internet connection.', { type: 'error' });
    }
  });

  // Enhanced offline detection
  window.addEventListener('online', () => {
    window.showToast?.('Connection restored!', { type: 'success' });
  });

  window.addEventListener('offline', () => {
    window.showToast?.('You are offline. Some features may not work.', { type: 'warning' });
  });

  // Enhanced performance monitoring
  if ('performance' in window) {
    window.addEventListener('load', () => {
      const loadTime = performance.now();
      console.log(`Page loaded in ${Math.round(loadTime)}ms`);
      if (loadTime > 3000) {
        console.warn('Slow page load detected');
      }
    });
  }

  // Enhanced accessibility
  document.addEventListener('keydown', (e) => {
    // Alt + M for mobile menu
    if (e.altKey && e.key === 'm') {
      const mobileMenuBtn = document.getElementById('mobileMenuBtn');
      if (mobileMenuBtn) mobileMenuBtn.click();
    }
    
    // Alt + S for search
    if (e.altKey && e.key === 's') {
      const searchInput = document.getElementById('q');
      if (searchInput) searchInput.focus();
    }
    
    // Alt + T for theme toggle
    if (e.altKey && e.key === 't') {
      const themeToggle = document.getElementById('toggleTheme');
      if (themeToggle) themeToggle.click();
    }
  });

  // Enhanced data persistence
  setInterval(() => {
    // Auto-save user preferences
    const userData = localStorage.getItem('userData');
    if (userData) {
      try {
        const data = JSON.parse(userData);
        // Update last activity
        data.lastActivity = Date.now();
        localStorage.setItem('userData', JSON.stringify(data));
      } catch(e) {
        console.warn('Error updating user data:', e);
      }
    }
  }, 60000); // Every minute
})();

// === FORCE INITIALIZATION ===
(function() {
  console.log('Force initialization starting...');
  
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('DOM loaded, initializing weather...');
      setTimeout(() => {
        if (!document.getElementById('place')?.textContent || document.getElementById('place').textContent === '—') {
          console.log('No weather data, loading London...');
          onSearchSubmit('London');
        }
      }, 1000);
    });
  } else {
    console.log('DOM already loaded, initializing weather...');
    setTimeout(() => {
      if (!document.getElementById('place')?.textContent || document.getElementById('place').textContent === '—') {
        console.log('No weather data, loading London...');
        onSearchSubmit('London');
      }
    }, 1000);
  }
})();