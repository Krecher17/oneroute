// Build-time settings. Everything comes from VITE_* variables (see .env.example), so no provider keys are hard-coded.
const env = import.meta.env;

export const DEFAULT_SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
function satelliteTiles(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return DEFAULT_SATELLITE_TILES;
  return value.trim().toLowerCase() === 'off' ? '' : value.trim();
}

export const config = {
  /** MapLibre style URL for the street map. Default: OpenFreeMap (free, no key, open data, fine for public apps). */
  mapStyleUrl: (env.VITE_MAP_STYLE_URL as string | undefined) ?? 'https://tiles.openfreemap.org/styles/liberty',
  /**
   * Satellite imagery (raster tiles with {z}/{x}/{y}). Default: Esri World Imagery, which needs no key and covers India well.
   * Esri's free endpoint has usage terms: before a large public launch, switch to a keyed provider (MapTiler, Stadia,
   * Mapbox...) by setting VITE_SATELLITE_TILES. Set it to "off" to hide the satellite buttons.
   */
  satelliteTiles: satelliteTiles(env.VITE_SATELLITE_TILES as string | undefined),
  satelliteAttribution: (env.VITE_SATELLITE_ATTRIBUTION as string | undefined) ?? 'Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community',
  /** Absolute server URL for the native (Capacitor) app. Empty = same origin, which is right for the website. */
  serverUrl: ((env.VITE_SERVER_URL as string | undefined) ?? '').replace(/\/+$/, ''),
  sentryDsn: (env.VITE_SENTRY_DSN as string | undefined) ?? '',
  environment: (env.MODE as string) ?? 'production',
  release: (env.VITE_RELEASE as string | undefined) ?? 'dev',
  dev: Boolean(env.DEV),
} as const;

export type AppConfig = typeof config;
