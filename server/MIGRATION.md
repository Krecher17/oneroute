# Migration status: legacy engine to React

The app was one 2,600-line `index.html`. Rewriting a working navigation app in one go risks breaking it, so it is moving to React
**screen by screen**, and it works at every step. The old logic lives in `client/src/legacy/engine.js` (original code, bundled, with a
handful of marked fixes); its screens are in `client/src/legacy/markup.html`. React and the engine talk through `src/lib/bridge.ts`.

| Screen / feature | Status | Notes |
|---|---|---|
| Sign in / sign up / Google / photo | **React** | `features/auth` |
| Install, update, offline messages | **React** (new) | `features/pwa` |
| Driving mode | **React** (new) | `features/driving`; reads live state from the engine |
| Language picker | **React** (new) | `components/LanguageSwitcher`: sign-in, setup, planner and trip header (`LanguageSlot` fills slots in the legacy markup) |
| Starting-point field | **React** (new) | `features/setup/StartPoint`; the rest of Setup is legacy |
| Setup (name, create / join trip, account bar) | Legacy | next: small, clear API |
| Planner (route preview, stops, alternatives) | Legacy | has its own map |
| Map screen (cars, pins, SOS, halt, weather, voice) | Legacy | the largest piece |
| Navigation (full screen) | Legacy | turn text is generated here |
| Status, Chat, Summary / report | Legacy | Summary draws a canvas report |

## Suggested order
1. **Setup** (create/join; needs a bridge command for each socket call).
2. **Status** and **Chat** (read-only lists, easy).
3. **Summary / report**.
4. **Planner**, then **Map** and **Navigation** last. Move socket handling into a typed `socket.ts` service first, so React and the engine share one connection.

## Rules for moving a screen
1. Build the React component with the same ids and classes first (the CSS is shared), so the screen looks identical.
2. Put its text in `locales/*.json` under real keys; delete its phrases from `locales/legacy/*.json`.
3. Remove its markup from `markup.html` and its code from `engine.js` in the same commit (a test lists unmatched phrases).
4. Anything the engine still needs becomes a `bridge.commands.*` entry; anything React needs to show becomes part of the `state` snapshot (`publishState()` in the engine).
5. Run: `npm run typecheck`, `npm test`, `npm run build`, then walk sign-up → create trip → driving mode in a browser at 390 px and 1440 px.

## Known gaps (worth doing before launch)
- **Spoken directions depend on the device having a voice** for the language (checked with `speechSynthesis.getVoices()`); otherwise they fall back to English. A server-side voice that supports Indian languages would remove that dependency. Wording lives in `src/lib/directions.ts` and the `nav.*` keys.
- **The browser calls OSRM, Overpass and Open-Meteo directly** for navigation steps, fuel stations, regroup suggestions and weather. Public servers will throttle a busy app. Move these calls behind the server (cached), which also removes them from the browser's network traffic.
- **Server messages outside sign-in** (trip, SOS errors) are English. Give them `code`s like auth.js does.
- **Trips live in server memory**: a restart ends every trip, and you can only run one server. Use Redis or a database when you need more.
- **Sentry source maps**: build with `BUILD_SOURCEMAPS=1`, upload to Sentry, then delete the `.map` files before deploying.

## Fixes made to the original code while moving it (all marked in engine.js)
- `startApp()` now hides the planner (it stayed above the map after "Confirm stops & start trip") and frees its map.
- The `beforeunload` clean-up sat outside the closure, so it could never stop a recording; it is inside now.
- "Has a location" now means a recent fix; before, the first position (taken when the trip was created) counted forever, so a failed GPS looked fine.
- Browser GPS goes through `platform/location.ts`, so the Android build can keep sending positions when the phone is locked.
- Service-worker removal code was deleted (the PWA now owns the service worker).
- The Navigation map now has your own icon, a follow camera (heading-up, tilted, speed-based zoom, pause + Recenter), convoy markers and turn badges on the route (`navFollowCamera`, `navUpdateMarkers`, `navRenderTurns`). Before it only framed the whole route and recentered.
- Trip creation, the fuel-station button and the live position all use the same precise-then-Wi-Fi location fallback (`platform/location.ts`).
- Three inline `style="..."` colours in the markup became classes (`accent-text`, `btn-danger-soft`) so the light theme can restyle them. Avoid new inline colours.
- Satellite buttons were added to the planner and navigation maps (`addSatFab`); the toggle now controls all three maps.
