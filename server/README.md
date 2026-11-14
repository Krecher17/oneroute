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
| **Location on laptops** | Precise GPS first; if it hasn't answered in 6 s, Wi-Fi/network location fills in. If nothing works, a help card says why (blocked, waiting for the permission prompt, or the device not sharing a location) and offers *Try again* and *Set my location on the map* |
| **Starting point** | An optional "Starting point" field above the destination (with the same fuzzy search and "Did you mean…?"). Left empty, the trip starts from your current location. A chosen start needs no GPS at all |
| **Time to destination** | "⏱ 2 h 13 min · 128 km · Arrive 7:45 pm" on the live map, the navigation map and driving mode. It counts down as you get closer |
| **Light / dark mode** | A toggle on the sign-in card, the setup screen, the planner and the trip header. Follows the device setting until you choose, then remembers your choice |
| **Navigation view** | Opens zoomed in on **your own icon** (an arrow that turns with your heading) with a tilted, heading-up camera that follows you, a little further out at highway speed. Upcoming turns are drawn **on the yellow route line** as badges (↰ ↱ ⟳ 🏁); the next one is larger and shows its distance. Panning the map pauses following and shows **Recenter** |
| **Turn-by-turn** | Starts with the trip and shows the next turn on the live map (a preview from the trip start until a location is found). Instructions and spoken prompts are translated into all six languages |
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
**Not translated yet:** road names (they come from OpenStreetMap), messages with names or numbers built by the engine, and server messages outside sign-in. Turn instructions and spoken prompts are translated. See MIGRATION.md.

## Location and turn-by-turn directions

**Why a laptop used to be stuck on "Still looking for GPS":** the app asked only for *precise* GPS, which laptops and desktops don't have, so the browser never answered. It now falls back to Wi-Fi location automatically and shows "Approximate location" (it can be a few hundred metres off). On Windows, Settings → Privacy & security → Location must be on, and the site must be allowed in the browser.

If there is still no location, the help card appears after about 12 seconds. **Set my location on the map** places you by hand (scrolls the map into view, you tap) and acts like GPS for the convoy and the directions, which is handy for testing on a PC.

**Directions** come from OSRM (see "Map providers" for hosting). They start with the trip, appear as a card on the live map and in full-screen Navigation, and keep running in Driving mode. They are spoken in your language only if the device has a voice for it (Windows and Android usually have Hindi; the others vary), otherwise in English, so the words and the voice always match. The cloud voice is English only.

### Starting point and time to destination

**Starting point:** type a place, press Search, pick it. Leave the box empty to start from where you are now (precise GPS, then Wi-Fi location, so it also works on a laptop). If you type a place but don't pick one, *Create trip* asks you to pick it or clear the box rather than silently ignoring it. Places must be in India (the server enforces this). Directions during the trip are always from where you actually are.

**Time to destination:** measured *along the route line* from your current position (not from the next turn), so it keeps shrinking correctly even if a signal drops or a turn is skipped. Time uses the route's own average speed from OSRM, so it is an estimate **without live traffic**. Arrival clock time keeps moving while you are stopped.

### Light and dark mode

First visit: follows the device's light/dark setting. After you tap the toggle, your choice is saved on that device. The light colours for the older screens are **generated from `src/legacy/legacy.css`** by `npm run theme` (run it after changing that file); hand-tuned exceptions are in `src/styles/theme-light.css`. Driving mode stays dark in both themes for night driving. The street map is light in both themes (OpenFreeMap has no dark style): set `VITE_MAP_STYLE_URL` to a dark style from your map provider if you want a dark map at night.

### Navigation view

Tap **➤ Navigation** on the live map. The camera locks onto your icon (zoom 17.4 when slow, 16.6 / 15.9 / 15.1 as speed rises; tilt 52°; your icon sits in the lower third so the road ahead is visible) and turns to face the direction you are moving once you pass about 4 km/h. Other drivers appear as small coloured badges with their initial. If you move or zoom the map by hand, following pauses until you tap **Recenter**. Without a location yet, it shows the whole route as a preview. Tunables (`NAV_ZOOM`, pitch, offset) are in `navFollowCamera` in `src/legacy/engine.js`.

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

## Live traffic

Set TOMTOM_TRAFFIC_API_KEY in the .env for the Node server you start, then restart it. The Traffic button on the route planner, convoy map, and navigation map enables the TomTom traffic flow overlay. It requests refreshed tiles about once a minute while enabled. Traffic is a map overlay only and does not change route selection or ETA.
