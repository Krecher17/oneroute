import maplibregl from 'maplibre-gl';
import { TrafficControl } from './traffic';
import { config } from './config';

/** True when a satellite tile URL is configured. Without one the satellite toggle is hidden. */
export const satelliteAvailable = Boolean(config.satelliteTiles);

// Used when the street style cannot be fetched (offline, blocked, provider down). The app keeps working:
// routes, cars and markers are drawn on a plain background instead of leaving the map dead.
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'oneroute-bg', type: 'background', paint: { 'background-color': '#dfe5ea' } }],
};

const baseLayerIds = new WeakMap<maplibregl.Map, string[]>();

function installSatellite(map: maplibregl.Map): void {
  const layers = map.getStyle()?.layers ?? [];
  if (!baseLayerIds.has(map)) baseLayerIds.set(map, layers.map((l) => l.id));
  if (!satelliteAvailable || map.getLayer('sat')) return;
  if (!map.getSource('sat')) {
    map.addSource('sat', {
      type: 'raster',
      tiles: [config.satelliteTiles],
      tileSize: 256,
      maxzoom: 19,
      attribution: config.satelliteAttribution,
    });
  }
  // Keep labels (symbol layers) on top of the imagery.
  const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } }, firstSymbol);
}

/** Creates a map with the configured provider and a safe fallback. Drop-in for `new maplibregl.Map(options)`. */
export function createMap(options: Omit<maplibregl.MapOptions, 'style'> & { style?: unknown }): maplibregl.Map {
  const { style: _ignored, ...rest } = options;
  const map = new maplibregl.Map({ ...rest, style: config.mapStyleUrl || FALLBACK_STYLE } as maplibregl.MapOptions);

  let styled = false;
  let fellBack = false;
  const fallBack = () => {
    if (styled || fellBack) return;
    fellBack = true;
    map.setStyle(FALLBACK_STYLE);
  };
  map.once('style.load', () => {
    styled = true;
    installSatellite(map);
  });
  map.on('error', (e: { error?: Error; tile?: unknown; sourceId?: string }) => {
    // A failed tile is normal on weak networks; a failed *style* means the map would never become ready.
    if (!styled && !e.tile && !e.sourceId) fallBack();
  });
  setTimeout(fallBack, 8000);
  map.addControl(new TrafficControl(), 'bottom-left');
  return map;
}

/** Shows or hides satellite imagery. Vector base layers are hidden, labels stay. */
export function setSatellite(map: maplibregl.Map, on: boolean): void {
  if (!satelliteAvailable || !map.isStyleLoaded()) return;
  installSatellite(map);
  for (const id of baseLayerIds.get(map) ?? []) {
    const layer = map.getLayer(id);
    if (layer && layer.type !== 'symbol') map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible');
  }
  if (map.getLayer('sat')) map.setLayoutProperty('sat', 'visibility', on ? 'visible' : 'none');
}
