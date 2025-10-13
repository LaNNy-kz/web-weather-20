import { cache, fmt } from './utils.js';

const $ = (id) => document.getElementById(id);

function bytesToSize(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${sizes[i]}`;
}
function approxBytesFromDataUrl(dataUrl) {
  return Math.round((dataUrl.length * 3) / 4);
}
// Note: UI toasts are provided by global `window.showToast` (see toasts.js). Fallback to alert().

function loadSession() {
  try { return JSON.parse(localStorage.getItem('session') || 'null'); } catch { return null; }
}
function saveSession(sess) {
  if (sess) localStorage.setItem('session', JSON.stringify(sess));
  else localStorage.removeItem('session');
}

function loadUser(email) {
  try {
    const users = JSON.parse(localStorage.getItem('users') || '[]');
    return users.find(u => u.email === email) || null;
  } catch { return null; }
}
function saveUser(updated) {
  const users = JSON.parse(localStorage.getItem('users') || '[]');
  const idx = users.findIndex(u => u.email === updated.email);
  if (idx >= 0) users[idx] = { ...users[idx], ...updated };
  else users.push(updated);
  localStorage.setItem('users', JSON.stringify(users));
}

function dataUrlFromFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

async function getWeatherByCityName(city) {
  const key = window.CONFIG?.OPENWEATHER_KEY;
  if (!key || key === 'YOUR_NEW_KEY_HERE') {
    if (window.showToast) window.showToast('Missing OpenWeather API key in config.js', { type: 'error' });
    throw new Error('Missing API key');
  }
  // geocode first
  const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${key}`;
  const geo = await fetch(geoUrl).then(r => r.ok ? r.json() : []);
  const item = geo[0]; if (!item) return null;
  const { lat, lon } = item;
  const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${key}`);
  if (!r.ok) return null;
  const current = await r.json();
  return { name: city, current };
}

function renderProfile(user) {
  const nameEl = $('pfName');
  const emailEl = $('pfEmail');
  const avatarPreview = $('avatarPreview');
  if (nameEl) nameEl.value = user?.name || '';
  if (emailEl) emailEl.value = user?.email || '';
  if (avatarPreview) {
    if (user?.avatar) { avatarPreview.src = user.avatar; avatarPreview.style.display = 'block'; }
    else { avatarPreview.removeAttribute('src'); avatarPreview.style.display = 'none'; }
  }
  // Avatar info (size/limits)
  const info = $('avatarInfo');
    if (info) {
    if (user?.avatar) {
      const approx = approxBytesFromDataUrl(user.avatar);
      info.textContent = `Saved: ${bytesToSize(approx)} (limit ~300 KB)`;
    } else {
      info.textContent = 'Max avatar size: ~300 KB';
    }
  }
}

function saveProfileHandler(curEmail) {
  const form = $('profileForm'); if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    const email = form.email.value.trim().toLowerCase();
    
    // Clear previous errors
    const errorElements = form.querySelectorAll('.error');
    errorElements.forEach(el => el.textContent = '');
    
    if (name.length < 2) {
      const nameError = form.querySelector('input[name="name"] + .error');
      if (nameError) nameError.textContent = 'Name must be at least 2 characters';
      return;
    }
    
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const emailError = form.querySelector('input[name="email"] + .error');
      if (emailError) emailError.textContent = 'Please enter a valid email address';
      return;
    }
    
    const user = loadUser(curEmail) || { email };
    user.name = name; 
    user.email = email;
    saveUser(user);
    saveSession({ email, name });
    
    // Update UI
    try { 
      window.setAuthUI?.(); 
      // Update profile display
      const userDisplayName = document.getElementById('userDisplayName');
      const userEmail = document.getElementById('userEmail');
      if (userDisplayName) userDisplayName.textContent = name;
      if (userEmail) userEmail.textContent = email;
    } catch {}
    
    if (window.showToast) window.showToast('Profile updated successfully!', { type: 'success' }); 
    else alert('Profile updated successfully!');
  });
}

function bindAvatarUpload(curEmail) {
  const fileInput = $('avatarFile'); if (!fileInput) return;
  // Client-side avatar handling: validate, resize if large, and store as data URL.
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]; if (!file) return;
    if (!file.type.startsWith('image/')) {
      if (window.showToast) window.showToast('Please select an image file.', { type: 'error' }); else alert('Please select an image file.');
      return;
    }

    // If file is small enough, convert directly. Otherwise resize to max width.
    const MAX_BYTES = 300 * 1024; // 300 KB target limit
    const MAX_WIDTH = 400; // max width in px when resizing

    let dataUrl = await dataUrlFromFile(file);

    // fast size check: try to approximate bytes from base64 length
    const approxBytes = (dataUrl.length * 3) / 4;
    if (approxBytes > MAX_BYTES) {
      // attempt to resize/compress
      try {
        dataUrl = await (async function resizeImageFile(file, maxWidth, quality = 0.8) {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              const ratio = img.width > maxWidth ? (maxWidth / img.width) : 1;
              const w = Math.round(img.width * ratio);
              const h = Math.round(img.height * ratio);
              const canvas = document.createElement('canvas');
              canvas.width = w; canvas.height = h;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0, w, h);
              // prefer jpeg for smaller size; if file was png and has transparency it will be flattened
              const out = canvas.toDataURL('image/jpeg', quality);
              resolve(out);
            };
            img.onerror = reject;
            // Use initial data URL to avoid CORS issues
            const reader = new FileReader();
            reader.onload = () => { img.src = reader.result; };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
        })(file, MAX_WIDTH, 0.8);
      } catch (e) {
        console.warn('Resize failed', e);
      }
    }

    // Final size guard
    const finalApprox = approxBytesFromDataUrl(dataUrl);
    const info = $('avatarInfo');
    if (info) {
      info.textContent = `Selected: ${bytesToSize((file.size || 0))}; Will save: ${bytesToSize(finalApprox)}`;
    }
    if (finalApprox > 600 * 1024) { // abort if still too large
      if (window.showToast) window.showToast('Image is too large after compression. Please choose a smaller image.', { type: 'error' }); else alert('Image is too large after compression. Please pick a smaller image.');
      return;
    }

    const user = loadUser(curEmail) || { email: curEmail };
    user.avatar = dataUrl;
    saveUser(user);
    renderProfile(user);
    try { window.setAuthUI?.(); } catch {}
    if (window.showToast) window.showToast('Avatar updated successfully!', { type: 'success' });
  });
}

// Expose a setter to update header UI (name + avatar). Called by profile/save flows.
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
    const user = loadUser(sess.email) || { name: sess.name, email: sess.email };
    if (profileBtn) profileBtn.textContent = user.name || 'Account';
    if (headerAvatar) {
      if (user.avatar) { headerAvatar.src = user.avatar; headerAvatar.style.display = 'inline-block'; }
      else { headerAvatar.removeAttribute('src'); headerAvatar.style.display = 'none'; }
    }
  } catch (e) { /* no-op */ }
};

function loadFavorites() {
  try { return JSON.parse(localStorage.getItem('favorites') || '[]'); } catch { return []; }
}
function saveFavorites(list) {
  localStorage.setItem('favorites', JSON.stringify(list));
}

async function renderFavorites() {
  const root = $('favorites'); if (!root) return;
  const list = loadFavorites();
  root.innerHTML = '';
  
  if (list.length === 0) {
    root.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 2rem; grid-column: 1 / -1;">No favorite cities yet. Add some cities to see them here!</p>';
    return;
  }
  
  for (const city of list) {
    try {
      const data = await getWeatherByCityName(city);
      if (!data) continue;
      const { current } = data;
      const div = document.createElement('div');
      div.className = 'favorite-card';
      const icon = current.weather?.[0]?.icon;
      div.innerHTML = `
        <div class="favorite-info">
          <div class="favorite-city">${city}</div>
          <div class="favorite-temp">${fmt.tempKtoC(current.main.temp)}° - ${current.weather?.[0]?.description || ''}</div>
        </div>
        <div class="favorite-actions">
          <button class="favorite-delete" data-city="${city}">🗑️</button>
        </div>
      `;
      root.appendChild(div);
      
      // Add click to search functionality
      div.addEventListener('click', (e) => {
        if (!e.target.classList.contains('favorite-delete')) {
          // Navigate to main page with search
          window.location.href = `index.html#q=${encodeURIComponent(city)}`;
        }
      });
    } catch {}
  }
  
  // Add delete handlers
  root.querySelectorAll('.favorite-delete').forEach(btn => {
    if (!btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const city = btn.getAttribute('data-city');
        const list = loadFavorites().filter(c => c !== city);
        saveFavorites(list);
        renderFavorites();
        if (window.showToast) window.showToast('City removed from favorites', { type: 'info' });
      });
    }
  });
}

function bindFavoritesUI() {
  const addBtn = $('favAdd');
  const input = $('favCity');
  if (addBtn && input && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', async () => {
      const city = input.value.trim(); 
      if (city.length < 2) {
        if (window.showToast) window.showToast('Please enter a city name', { type: 'warning' });
        return;
      }
      
      const list = loadFavorites();
      if (list.includes(city)) {
        if (window.showToast) window.showToast('City already in favorites!', { type: 'info' });
        return;
      }
      
      list.push(city); 
      saveFavorites(list);
      input.value = '';
      renderFavorites();
      if (window.showToast) window.showToast('City added to favorites!', { type: 'success' });
    });
    
    // Allow adding with Enter key
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        addBtn.click();
      }
    });
  }
}

// === PROFILE PAGE FUNCTIONALITY ===
function bindProfileButtons() {
  // Theme toggle
  const themeToggle = document.getElementById('toggleTheme');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const isLight = document.body.classList.contains('light');
      setTheme(!isLight);
      const themeText = !isLight ? 'Light' : 'Dark';
      if (window.showToast) window.showToast(`Switched to ${themeText} theme`, { type: 'success' });
    });
  }

  // Clear cache button
  const clearCacheBtn = document.getElementById('clearCache');
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all data? This will remove your favorites, search history, and profile data.')) {
        localStorage.clear();
        try { 
          window.setAuthUI?.(); 
          if (window.showToast) window.showToast('All data cleared successfully', { type: 'success' });
          // Reload page to reset everything
          setTimeout(() => window.location.reload(), 1000);
        } catch(e) { 
          alert('Cache cleared successfully'); 
        }
      }
    });
  }

  // Auth button
  const authBtn = document.getElementById('openAuth');
  if (authBtn) {
    authBtn.addEventListener('click', () => {
      const authModal = document.getElementById('authModal');
      if (authModal) {
        authModal.setAttribute('aria-hidden', 'false');
        authModal.style.display = 'flex';
      }
    });
  }

  // Update user stats
  function updateUserStats() {
    const favoritesCount = document.getElementById('favoritesCount');
    const locationsCount = document.getElementById('locationsCount');
    
    if (favoritesCount) {
      const favs = loadFavorites();
      favoritesCount.textContent = favs.length;
    }
    
    if (locationsCount) {
      const searches = JSON.parse(localStorage.getItem('lastSearches') || '[]');
      locationsCount.textContent = searches.length;
    }
  }

  // Update user display info
  function updateUserDisplay() {
    const userDisplayName = document.getElementById('userDisplayName');
    const userEmail = document.getElementById('userEmail');
    const sess = loadSession();
    
    if (sess) {
      const user = loadUser(sess.email) || { name: sess.name, email: sess.email };
      if (userDisplayName) userDisplayName.textContent = user.name || 'User';
      if (userEmail) userEmail.textContent = user.email || 'user@example.com';
    } else {
      if (userDisplayName) userDisplayName.textContent = 'Guest User';
      if (userEmail) userEmail.textContent = 'guest@example.com';
    }
  }

  // Initialize stats and display
  updateUserStats();
  updateUserDisplay();

  // Update stats when favorites change
  const originalRenderFavorites = renderFavorites;
  renderFavorites = function() {
    originalRenderFavorites();
    updateUserStats();
  };
}

// Theme management
function setTheme(isLight) {
  if (isLight) {
    document.body.classList.add('light');
    localStorage.setItem('theme', 'light');
  } else {
    document.body.classList.remove('light');
    localStorage.setItem('theme', 'dark');
  }
}

// Load saved theme
function loadTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'light') {
    document.body.classList.add('light');
  }
}

// bootstrap profile page
(function initProfile() {
  // Load theme first
  loadTheme();
  
  const sess = loadSession();
  if (!sess) {
    // if not logged in, invite to login
    try { document.getElementById('openAuth')?.click(); } catch {}
  }
  const user = sess ? loadUser(sess.email) || { email: sess.email, name: sess.name } : null;
  renderProfile(user);
  bindAvatarUpload(sess?.email || user?.email || '');
  saveProfileHandler(sess?.email || user?.email || '');
  bindFavoritesUI();
  renderFavorites();
  bindProfileButtons();
})();


