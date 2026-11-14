import type { IControl, Map, RasterTileSource } from 'maplibre-gl';
import { config } from './config';

const LAYER = 'oneroute-traffic';
const REFRESH_MS = 60_000;
let availability: Promise<boolean> | undefined;

function trafficAvailable(): Promise<boolean> {
  availability ??= fetch(config.serverUrl + '/api/traffic/status')
    .then(async response => response.ok && (await response.json()).available === true)
    .catch(() => false)
    .finally(() => { availability = undefined; });
  return availability;
}

export class TrafficControl implements IControl {
  private map?: Map;
  private timer?: number;
  private enabled = false;
  private failed = false;
  private container = document.createElement('div');
  private button = document.createElement('button');
  private status = document.createElement('span');

  onAdd(map: Map): HTMLElement {
    this.map = map;
    this.container.className = 'maplibregl-ctrl traffic-control';
    this.button.type = 'button';
    this.button.textContent = 'Traffic';
    this.button.disabled = true;
    this.button.setAttribute('aria-pressed', 'false');
    this.button.onclick = () => this.toggle();
    this.status.className = 'traffic-status';
    this.status.setAttribute('role', 'status');
    this.container.append(this.button, this.status);
    map.on('error', this.onError);
    map.on('sourcedata', this.onSourceData);
    map.on('style.load', this.render);
    void trafficAvailable().then(available => {
      if (this.map !== map) return;
      this.button.disabled = !available;
      if (!available) this.status.textContent = 'Traffic unavailable';
    });
    return this.container;
  }

  onRemove(): void {
    window.clearInterval(this.timer);
    this.map?.off('error', this.onError);
    this.map?.off('sourcedata', this.onSourceData);
    this.map?.off('style.load', this.render);
    this.container.remove();
    this.map = undefined;
  }

  private toggle(): void {
    this.enabled = !this.enabled;
    this.failed = false;
    this.status.textContent = '';
    this.button.setAttribute('aria-pressed', String(this.enabled));
    window.clearInterval(this.timer);
    this.render();
    if (this.enabled) this.timer = window.setInterval(this.render, REFRESH_MS);
  }

  private render = (): void => {
    const map = this.map;
    if (!map?.getStyle()) return;
    if (!this.enabled) {
      if (map.getLayer(LAYER)) map.removeLayer(LAYER);
      if (map.getSource(LAYER)) map.removeSource(LAYER);
      return;
    }
    const tiles = [config.serverUrl + '/api/traffic/tiles/{z}/{x}/{y}?minute=' + Math.floor(Date.now() / REFRESH_MS)];
    const source = map.getSource<RasterTileSource>(LAYER);
    if (source) {
      source.setTiles(tiles);
      return;
    }
    map.addSource(LAYER, { type: 'raster', tiles, tileSize: 256, minzoom: 7, maxzoom: 22, attribution: 'Traffic © TomTom' });
    const before = map.getStyle().layers.find(layer => layer.type === 'symbol' || /^(planned-route|route-|nav-route)/.test(layer.id));
    map.addLayer({ id: LAYER, type: 'raster', source: LAYER, paint: { 'raster-opacity': 0.88 } }, before?.id);
  };

  private onError = (event: { sourceId?: string }): void => {
    if (!this.enabled || event.sourceId !== LAYER) return;
    this.failed = true;
    this.status.textContent = 'Some traffic tiles unavailable';
  };

  private onSourceData = (event: { sourceId?: string; sourceDataType?: string }): void => {
    if (this.enabled && event.sourceId === LAYER && event.sourceDataType === 'metadata') {
      if (this.failed) this.status.textContent = '';
      this.failed = false;
    }
  };
}
