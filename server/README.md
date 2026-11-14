# ONEROUTE

Convoy control for groups on the road. A Node server (Express + Socket.IO) and a web/app frontend (Vite + React + TypeScript) that runs in the browser, installs as an app (PWA), and is ready to be wrapped for Android with Capacitor.

```
oneroute/
├─ client/   Vite + React + TypeScript (frontend source)
└─ server/   Node server. `npm run build` in client/ writes the website into server/public/
```

---

## What's new

| Area | What you get |
|---|---|
| **Light / dark mode** | A toggle on the sign-in card, setup screen, planner and trip header. Follows the device setting on first visit, then remembers your choice. Driving mode stays dark in both themes for night driving. |
| **Offline / PWA** | Service worker with an app shell that is cached on first load. The app opens and shows the last convoy state even with no signal. Updates are downloaded silently and applied on the next launch — **the app never reloads mid-drive**. An install prompt appears on supported browsers. |
| **Installable (PWA)** | Web app manifest, full icon set (192 / 512 / maskable), offline app shell, install prompt, and an "update ready" banner that waits until the drive is over. |
| **Sentry error reporting** | Browser and server errors are captured and sent to Sentry when `SENTRY_DSN` is set. Off by default. Locations, names and tokens are **never** sent — the `beforeSend` hook strips all PII before anything leaves the device or server. |
| **Live traffic overlay** | Set `TOMTOM_TRAFFIC_API_KEY` on the server and a Traffic button appears on the route planner, convoy map and navigation map. Tiles refresh roughly every 45 seconds while enabled. Traffic is a visual overlay only — it does not change route selection or ETA. |
| **Navigation view** | Opens zoomed in on your own icon (an arrow that rotates with your heading) with a tilted, heading-up camera. Upcoming turns are drawn on the yellow route line as badges (↰ ↱ ⟳ 🔃); the next turn is larger and shows its distance. Panning pauses following and shows a **Recenter** button. |
| **Turn-by-turn card** | A live card on the map shows the next turn, distance, road name and ETA from the moment the trip starts (preview mode until GPS is found, then live). Translated into all six languages. |
| **GPS help card** | If no location arrives within 12 seconds of a trip starting, a card explains *why* (permission blocked, permission prompt waiting, or device not sharing location) and offers **Try again** and **Set my location on the map**. |
| **Starting point** | An optional field above the destination. Leave it empty to start from your current location; type a place to plan the whole route without GPS. Same fuzzy search and "Did you mean…?" as the destination. |
| **Time to destination** | "⏱ 2 h 13 min · 128 km · Arrive 7:45 pm" on the live map, navigation map and driving mode. Counts down as you get closer; measured along the route from your actual position. |
| **Driving mode** | Big-button screen: speed, next turn (with spoken guidance), convoy status, hold-to-send SOS (1.2 s, so bumps can't trigger it), halt, voice message, mute. Auto-activates after 8 seconds above 20 km/h. |
| **Location on laptops** | Precise GPS first; if it hasn't answered in 6 s, Wi-Fi / network location fills in automatically. |
| **Frontend** | Vite + React 19 + TypeScript. Sign-in is real React; the rest of the UI still runs your original engine inside it (see MIGRATION.md). |
| **Map tiles** | OpenFreeMap (free, no key) for streets. Satellite view (Esri World Imagery by default) with one toggle, shared across the planner, live map and navigation map. Falls back to a plain background when offline — routes and cars are still drawn. |
| **Languages** | English, हिन्दी, മലയാളം, தமிழ், ಕನ್ನಡ, తెలుగు across all React-built screens; Hindi + Malayalam on the legacy screens. |
| **Android-ready** | Capacitor config, background-location and push-registration code included. The native Android project is built separately (see [Android app](#android-app-later)). |
| **Accounts** | Local file storage in `server/data/accounts.json` — no Supabase or external database. |
| **Configurable service URLs** | `OVERPASS_URL`, `WEATHER_URL` and `OSRM_URL` can all be overridden via environment variables to point at self-hosted instances. |
| **Static file serving** | The server now serves both `server/public/` (Vite build output) and the legacy `public/` folder, with correct `Cache-Control` headers: immutable for hashed assets, `no-cache` for the service worker, manifest and `index.html`. |

---

## First-time setup

1. **Copy your static files into the client.** From your existing `server/public/` copy these into `client/public/`:
   `orb.js`, `icons/` (keep `favicon-48.png`), and the legal pages `terms.html`, `privacy.html`, `cookies.html`, `refund.html`.
   The build never deletes files already in `server/public/`.

2. Install and run:
   ```bash
   cd server && npm install && node index.js        # API server on :3001
   cd client && npm install && npm run dev          # app with hot reload on :5173 (proxies to :3001)
   ```

3. Build for production (output goes into `server/public/`, which the server already serves):
   ```bash
   cd client && npm run build
   ```

4. Checks: `npm run typecheck` and `npm test` in `client/`.

Copy `client/.env.example` to `client/.env.production` and fill in what you use. Everything is optional.

---

## Environment variables

### Client (`client/.env.production`)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_SERVER_URL` | *(empty — uses same origin)* | Full URL of the API server, required for the Android / iOS app |
| `VITE_MAP_STYLE_URL` | OpenFreeMap liberty style | Custom MapLibre style URL (MapTiler, Stadia, self-hosted Protomaps…) |
| `VITE_SENTRY_DSN` | *(off)* | Sentry DSN for browser error reporting |
| `VITE_GOOGLE_CLIENT_ID` | *(off)* | Google OAuth client ID for "Sign in with Google" |

### Server

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Server port |
| `DATA_DIR` | `./data` | Where accounts, sessions, avatars and TTS cache are stored. **Persist this directory.** |
| `SENTRY_DSN` | *(off)* | Sentry DSN for server error reporting |
| `TOMTOM_TRAFFIC_API_KEY` | *(off)* | Enables the live traffic overlay |
| `OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Overpass API for nearest-help (SOS) |
| `WEATHER_URL` | `https://api.open-meteo.com/v1/forecast` | Weather along the route |
| `OSRM_URL` | `https://router.project-osrm.org/route/v1/driving` | Routing engine |
| `ELEVENLABS_API_KEY` | *(off — uses browser voice)* | ElevenLabs key for server-side navigation voice |
| `ELEVENLABS_VOICE_ID` | `7vmb1wpSAT1c83jjLIeZ` | ElevenLabs voice ID |
| `ELEVENLABS_MODEL` | `eleven_flash_v2_5` | ElevenLabs model |
| `TTS_DAILY_CHARS` | `30000` | Daily character spend cap for ElevenLabs |
| `GOOGLE_CLIENT_ID` | *(off)* | Google OAuth client ID (must match the client) |

---

## Light / dark mode

First visit follows the device's `prefers-color-scheme`. After tapping the toggle your choice is saved in `localStorage` on that device. Light colours for the legacy screens are **generated** from `src/legacy/legacy.css` by `npm run theme` (run after changing that file); hand-tuned overrides live in `src/styles/theme-light.css`.

The street map is light in both themes (OpenFreeMap has no dark variant). Set `VITE_MAP_STYLE_URL` to a dark style from your provider if you want a dark map at night.

---

## Offline / PWA

The Vite build produces a service worker via `vite-plugin-pwa`. On first load the app shell, the map style and the route engine are pre-cached. On subsequent visits the app opens instantly, even without a network. While offline:

- The convoy map shows the last known state.
- The route planner still works if the destination was searched before.
- Routing and geocoding require a connection (they hit OSRM / Nominatim / Photon).

When a new version is deployed, the service worker downloads it in the background. A banner asks the driver to reload — but only after the trip ends, so an update **never interrupts navigation**.

---

## Map providers

**Streets:** OpenFreeMap (`https://tiles.openfreemap.org/styles/liberty`). Free, no key, public apps allowed. Consider [donating](https://openfreemap.org). Override with `VITE_MAP_STYLE_URL`.

**Satellite:** Esri World Imagery by default. The choice (street / satellite) is saved and shared across the planner, live map and navigation map.

**Traffic:** TomTom flow raster tiles proxied through the server (`/api/traffic/tiles/:z/:x/:y`). Set `TOMTOM_TRAFFIC_API_KEY` to enable.

---

## Place search

Searches India only (enforced server-side). Falls back through four strategies:

1. Nominatim (exact spelling)
2. Photon (typo-tolerant, full query)
3. Photon on progressively shorter queries
4. "Did you mean…?" — phonetic and edit-distance variants, ranked by similarity to what was typed

---

## Navigation view

Tap **➤ Navigation** on the live map. Camera settings: zoom 17.4 (slow) → 15.1 (highway), tilt 52°, your icon in the lower third. Turns to face your heading above ~4 km/h. Other drivers appear as small coloured badges. Panning pauses following until you tap **Recenter**.

Tunables (`NAV_ZOOM`, pitch, offset) are in `navFollowCamera` in `src/legacy/engine.js`.

---

## Driving mode

Opened from a button under "Live convoy" during a trip. Shows speed, next turn (spoken guidance keeps running), who is behind or off-route, and big touch controls. SOS needs a 1.2-second hold — a pocket touch or bump won't send one; a single tap cancels. "Automatically when driving" starts it after 8 seconds above 20 km/h and never re-opens it for that trip once you close it by hand.

---

## Android app (later)

The code is prepared but **the native project has not been built or tested yet**. When ready:

1. `cd client && npm i @capacitor-community/background-geolocation @capacitor/push-notifications`
2. Set `VITE_SERVER_URL=https://your-server` in `.env.production`, change `appId` in `capacitor.config.ts` (permanent once published), then `npx cap add android`.
3. `npm run cap:android` builds the web app, syncs it and opens Android Studio.
4. Add to `AndroidManifest.xml`: `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS`.
5. Push notifications: create a Firebase project, add `google-services.json`. The server stores device tokens per account (`pushTokensFor(userId)` in `auth.js`). **Sending** (SOS, missed-turn alerts) is a server job still to write, using Firebase Cloud Messaging.
6. Play Store: background location needs a declaration, prominent in-app disclosure and a completed Data safety form. Plan time for the review.

Known items to finish: profile pictures use relative `/avatar/...` paths — test these against `VITE_SERVER_URL` before release.

---

## Server notes

- Accounts and sessions live in `server/data/accounts.json`; avatars in `server/data/avatars/`. **Back up and persist `data/`** (set `DATA_DIR` on hosts with ephemeral disks). Trips are in memory only.
- TTS audio is cached in `server/data/tts/` so repeated phrases cost no ElevenLabs quota.
- `Cross-Origin-Opener-Policy: same-origin` (set in `index.js`) can block the Google sign-in popup from reporting back. If Google sign-in misbehaves, try `same-origin-allow-popups`.
- `server/package.json` no longer has Supabase. `@turf/turf` is installed but unused (safe to remove).
- Rotate any key that was pasted into chat or committed (ElevenLabs key in `config.json`, old Supabase keys).
