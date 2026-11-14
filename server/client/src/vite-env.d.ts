/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_MAP_STYLE_URL?: string;
  readonly VITE_SATELLITE_TILES?: string;
  readonly VITE_SATELLITE_ATTRIBUTION?: string;
  readonly VITE_SERVER_URL?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_RELEASE?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }
