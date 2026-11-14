# ONEROUTE

Convoy control for groups on the road. A Node server (Express + Socket.IO) and a web/app frontend (Vite + React + TypeScript) that
runs in the browser, installs as an app (PWA) and is ready to be wrapped for Android with Capacitor.

```
oneroute/
├─ client/   Vite + React + TypeScript (this is the frontend source)
└─ server/   Node server. `npm run build` in client/ writes the website into server/public/
```

## What changed in this version

| Area | What you get |
|---|---|
| **Frontend** | Vite + React 19 + TypeScript. Sign-in is real React; the rest still runs on your original engine inside it (see MIGRATION.md) |
| **Installable (PWA)** | Manifest, icons, offline app shell, install prompt, "update ready" prompt that **never reloads mid-drive** |
| **Map tiles** | OpenFreeMap (free, no key) for the street map instead of OpenStreetMap's own tile server, which isn't meant for heavy public use. **Satellite view is on** (Esri World Imagery by default) with a button on the planner map, the live map and the navigation map, sharing one saved choice |
| **Errors** | Sentry for browser and server. Off unless you set a DSN. Locations, names, tokens are never sent |
| **Languages** | English, हिन्दी, മലയാളം, தமிழ், ಕನ್ನಡ, తెలుగు for all React-built UI; Hindi + Malayalam for the legacy screens |
| **Driving mode** | Big-button screen: next turn, speed, convoy status, hold-to-send SOS, halt, voice message, mute. Can switch itself on above 20 km/h |
| **Android-ready** | Capacitor config, background-location and push-registration code. The Android project itself is built later (see "Android app") |
| **Accounts** | Local storage (no Supabase), see server/auth.js |
| **Fixes found on the way** | The route planner stayed on screen after starting a trip. SOS could cancel itself when the finger lifted |

## First-time setup

1. **Copy your static files into the client.** From your current `server/public/` copy these into `client/public/`:
   `orb.js`, `icons/` (keep `favicon-48.png`), and the legal pages `terms.html`, `privacy.html`, `cookies.html`, `refund.html`.
   The build never deletes your files in `server/public/`; it only replaces what it generated.
2. Install and run:
   ```bash
   cd server && npm install && node index.js          # the API, on :3001
   cd client && npm install && npm run dev             # the app with hot reload, on :5173 (proxies to :3001)
   ```
3. Build for production (writes into `server/public/`, which the server already serves):
   ```bash
   cd client && npm run build
   ```
4. Checks: `npm run typecheck` and `npm test` in `client/` (37 tests).

Copy `client/.env.example` to `client/.env.production` and set what you use. Everything is optional.

## Map providers

Default street map: **OpenFreeMap** (`https://tiles.openfreemap.org/styles/liberty`). It is free, needs no key and permits public apps.
Please consider donating to them if you rely on it. To use another provider, set `VITE_MAP_STYLE_URL`
(MapTiler, Stadia, self-hosted Protomaps...). If the map style can't load (offline), the app falls back to a plain background and still draws routes and cars.

**Satellite** uses Esri World Imagery by default so it works out of the box. Esri's free endpoint comes with usage terms, so **before a large public launch switch to a keyed provider** (MapTiler, Stadia, Mapbox...) by setting `VITE_SATELLITE_TILES` and `VITE_SATELLITE_ATTRIBUTION`. Set `VITE_SATELLITE_TILES=off` to hide the satellite buttons.

Routing and place search still use the public OSRM, Nominatim, Photon, Overpass and Open-Meteo servers. Those are fine while you test but have fair-use limits.
Before launch, point the server at hosted or self-hosted copies with `OSRM_URL`, `NOMINATIM_URL`, `PHOTON_URL`, `OVERPASS_URL`, `WEATHER_URL` (server/.env).

## Updates and the offline shell

The service worker uses *prompt* mode: when a new version is ready, a small message offers **Update now / Later**. It is hidden while the vehicle moves faster than 10 km/h and never reloads on its own.
The server sends `Cache-Control: no-cache` for `index.html`, `sw.js` and the manifest, and a one-year cache for hashed files in `/assets`. Keep it that way or updates stop reaching people.
The PWA needs **HTTPS** (localhost is exempt). To change the icon, edit `client/public/icons/icon.svg` / `icon-maskable.svg` and re-export the PNGs at 192, 512, 512-maskable and 180 (apple-touch).

## Error reporting (Sentry)

Browser: set `VITE_SENTRY_DSN` at build time. Server: set `SENTRY_DSN` in `server/.env` (and `npm install` once). Errors only: no tracing, no session replay. Headers, cookies, query strings and user data are stripped before sending.

## Languages

The language picker is on the sign-in card, the setup screen (join with a code / create a trip), the route planner and the trip header (so it stays reachable on every tab during a trip).

React UI strings live in `client/src/i18n/locales/<code>.json`. A test fails if any language is missing a key, or drops a `{{variable}}`. To add a language: add the file, add it to `LANGUAGES` and `loaders` in `src/i18n/index.ts`.
**The translations were written by an AI and need review by native speakers before launch**, especially the safety wording (SOS, halt, emergency).
Legacy screens are translated by a phrase dictionary (`locales/legacy/hi.json`, `ml.json`); a test fails if markup text is added without a translation. Other languages show English there until they get a dictionary.
**Not translated yet:** turn instructions and spoken guidance ("Turn right onto…"), messages with names or numbers built by the engine, and server messages outside sign-in. See MIGRATION.md.

## Driving mode

A button under "Live convoy" opens it during a trip. It shows speed, the next turn (and keeps spoken guidance running), who is behind or off route, and big controls.
SOS needs a 1.2 second hold, so a pocket or a bump can't send one; one tap cancels. Turning on "automatically when driving" starts it after 8 seconds above 20 km/h (never again for that trip once you close it by hand).

## Android app (later)

The code is prepared but **the native project has not been built or tested**. When you are ready:

1. `cd client && npm i @capacitor-community/background-geolocation @capacitor/push-notifications`
2. Set `VITE_SERVER_URL=https://your-server` in `.env.production`, change `appId` in `capacitor.config.ts` (permanent once published), then `npx cap add android`.
3. `npm run cap:android` builds the web app, syncs it and opens Android Studio.
4. In `AndroidManifest.xml` add `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS` (follow the background-geolocation plugin's README).
5. Push: create a Firebase project, add `google-services.json`. The app already registers each device (`POST /api/push/register`, stored per account). **Sending** notifications (SOS, missed turn) is a server job you still need to write with Firebase Cloud Messaging (`pushTokensFor(userId)` in auth.js gives the tokens).
6. Play Store: background location needs a declaration and a prominent in-app disclosure, and the Data safety form must list location and account data. Plan time for that review.

Known things to finish for the native build: profile pictures use relative `/avatar/...` addresses, and the engine builds some links itself, so test avatars and invite links against `VITE_SERVER_URL`. Your server already allows any origin (CORS `*`), which works with bearer tokens but is worth tightening to your own origins for launch.

## Server notes

- `server/package.json` no longer has Supabase. `@turf/turf` is installed but unused (safe to remove). `maplibre-gl` is only kept so the old `/vendor` route still works.
- Accounts live in `server/data/accounts.json` (password hashes, sessions, device tokens), avatars in `server/data/avatars/`. **Back up and persist `data/`** (set `DATA_DIR` on hosts with a disk that resets). Trips are still only in memory.
- `Cross-Origin-Opener-Policy: same-origin` (set in index.js) can stop the Google sign-in popup from reporting back. If Google sign-in misbehaves, try `same-origin-allow-popups`.
- Rotate any key that was pasted into chat or committed (ElevenLabs key in `config.json`, the old Supabase keys).
