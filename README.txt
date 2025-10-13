# Enhanced weather app template

**Security note:** this repo may contain an API key in `config.js`. Revoke/replace any exposed key in your OpenWeather account and keep real keys out of version control (use a local `config.js` or a server-side proxy).

## Improvements included
- City search with suggestions (OpenWeather Geocoding) + debounce.
- One-click geolocation.
- Fast loading and skeleton UI for smoother rendering.
- Caching responses (localStorage) with TTL.
- Clear error messages and status area.
- Light/dark theme remembered in localStorage.
- 24-hour and 7-day views (based on `/forecast`).
- AQI (air quality) from `air_pollution`.
- Simple file structure: `index.html`, `styles.css`, `utils.js`, `app.js`, `config.js`.

## Run locally
1. Create `config.js` in the project root with your key (do NOT commit it):
   ```js
   window.CONFIG = { OPENWEATHER_KEY: "YOUR_NEW_KEY_HERE" };
   ```
2. Open `index.html` in a browser (for Chrome you may prefer a simple static server, e.g. `npx serve .`).
3. Enter a city or click the "My location" button.

## Production tips
- Keep API keys on the server (proxy requests) — exposing keys in client code is insecure.
- Enable HTTP caching for static assets.
- Consider a PWA manifest + offline caching via Workbox.
- Run Lighthouse and aim for 90+ in Performance/Best Practices.
- For pollen/allergen data consider separate providers (Tomorrow.io, Ambee, etc.).
