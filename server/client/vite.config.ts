import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const DEFAULT_SATELLITE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const hostOf = (url: string): string | null => { try { return new URL(url).hostname; } catch { return null; } };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const devServer = env.DEV_SERVER_URL || 'http://localhost:3001';
  const styleHost = hostOf(env.VITE_MAP_STYLE_URL ?? DEFAULT_STYLE);
  const satSetting = (env.VITE_SATELLITE_TILES ?? '').trim();
  const satUrl = satSetting === '' ? DEFAULT_SATELLITE : satSetting.toLowerCase() === 'off' ? '' : satSetting;
  const satHost = hostOf(satUrl.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
  const mapHosts = [styleHost, satHost].filter(Boolean) as string[];

  return {
    plugins: [
      react(),
      VitePWA({
        // "prompt": a new version waits until the person taps Update. It never reloads mid-drive.
        registerType: 'prompt',
        injectRegister: false, // registered from React so we can show our own "update ready" message
        manifest: {
          name: 'ONEROUTE: Convoy Control',
          short_name: 'ONEROUTE',
          description: 'Keep your group on one route: live convoy map, missed-turn alerts, regroup points and SOS.',
          theme_color: '#17191d',
          background_color: '#17191d',
          display: 'standalone',
          orientation: 'any',
          start_url: '/',
          scope: '/',
          lang: 'en',
          categories: ['navigation', 'travel', 'utilities'],
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // Only the generated app shell is precached; your own static pages are left alone.
          globPatterns: ['index.html', 'assets/**/*.{js,css,woff2}', 'icons/*.png', 'orb.js'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          cleanupOutdatedCaches: true,
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [
            /^\/api\//, /^\/socket\.io\//, /^\/geocode/, /^\/avatar\//, /^\/health/, /^\/vendor\//,
            /^\/(terms|privacy|cookies|refund)\.html$/,
          ],
          runtimeCaching: [
            // Map tiles: the same tiles are re-used constantly on a route, so cache them (bounded) for weak networks.
            {
              urlPattern: ({ url }) => mapHosts.includes(url.hostname) && (/\.(pbf|mvt|png|jpg|jpeg|webp)$/.test(url.pathname) || /\/tile\//.test(url.pathname)),
              handler: 'CacheFirst',
              options: { cacheName: 'map-tiles', expiration: { maxEntries: 800, maxAgeSeconds: 7 * 24 * 3600 }, cacheableResponse: { statuses: [0, 200] } },
            },
            // Style, sprites, glyphs, TileJSON: show the cached copy instantly, refresh in the background.
            {
              urlPattern: ({ url }) => mapHosts.includes(url.hostname),
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'map-style', expiration: { maxEntries: 120, maxAgeSeconds: 14 * 24 * 3600 }, cacheableResponse: { statuses: [0, 200] } },
            },
            // Profile pictures never change at the same address.
            {
              urlPattern: ({ url }) => /^\/avatar\/[a-f0-9]{32}\.jpg$/.test(url.pathname),
              handler: 'CacheFirst',
              options: { cacheName: 'avatars', expiration: { maxEntries: 150, maxAgeSeconds: 30 * 24 * 3600 } },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
    ],
    build: {
      outDir: '../server/public',
      emptyOutDir: false, // your terms/privacy pages live there; `prebuild` removes only generated files
      target: 'es2020',
      sourcemap: env.BUILD_SOURCEMAPS === '1' ? 'hidden' : false,
      chunkSizeWarningLimit: 1500,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': devServer,
        '/geocode': devServer,
        '/avatar': devServer,
        '/health': devServer,
        '/socket.io': { target: devServer, ws: true },
      },
    },
    test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
  };
});
