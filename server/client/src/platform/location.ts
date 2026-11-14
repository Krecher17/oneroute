import { registerPlugin } from '@capacitor/core';
import { bridge } from '../lib/bridge';
import { isNative } from './index';

/**
 * A drop-in for navigator.geolocation.watchPosition / clearWatch.
 *  - Website / installed web app: the browser's own GPS (works while the screen is on).
 *  - Android/iOS app: a foreground service keeps sending positions when the phone is locked or another
 *    app is open, which a web page cannot do. Requires the plugin from README ("Android app" section).
 */
interface NativeLocation {
  latitude: number; longitude: number; accuracy: number;
  altitude: number | null; altitudeAccuracy: number | null;
  bearing: number | null; speed: number | null; time: number | null; simulated?: boolean;
}
interface NativeError { code?: string; message?: string }
interface BackgroundGeolocationPlugin {
  addWatcher(
    options: { backgroundMessage?: string; backgroundTitle?: string; requestPermissions?: boolean; stale?: boolean; distanceFilter?: number },
    callback: (location?: NativeLocation, error?: NativeError) => void,
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
}

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

type Success = (position: GeolocationPosition) => void;
type Failure = (error: GeolocationPositionError) => void;

const nativeIds = new Map<number, string>();
let counter = 0;

const toPosition = (l: NativeLocation): GeolocationPosition => ({
  coords: {
    latitude: l.latitude, longitude: l.longitude, accuracy: l.accuracy,
    altitude: l.altitude, altitudeAccuracy: l.altitudeAccuracy, heading: l.bearing, speed: l.speed,
    toJSON() { return this; },
  },
  timestamp: l.time ?? Date.now(),
  toJSON() { return this; },
}) as GeolocationPosition;

// Native errors become the same shape the browser uses, so existing error messages keep working.
const toError = (e: NativeError): GeolocationPositionError => ({
  code: e.code === 'NOT_AUTHORIZED' ? 1 : 2,
  message: e.message ?? e.code ?? 'Location unavailable',
  PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3,
}) as GeolocationPositionError;

/**
 * Browser location that works on laptops as well as phones.
 * Phones have a GPS chip, so the precise ("high accuracy") request answers. Laptops and desktops do not, so that request
 * just times out forever. We therefore ask for precise GPS and, if it has not answered within a few seconds, also start a
 * network (Wi-Fi) location watch. Precise fixes win whenever they exist; the network one fills the gap.
 */
const adaptive = new Map<number, { high: number | null; low: number | null; timer: number }>();
const FALLBACK_AFTER_MS = 6000;
const PRECISE_FRESH_MS = 20000;
const ERROR_REPEAT_MS = 30000;

function watchAdaptive(success: Success, failure: Failure | undefined, options: PositionOptions | undefined): number {
  const api = navigator.geolocation;
  const id = ++counter;
  const entry: { high: number | null; low: number | null; timer: number } = { high: null, low: null, timer: 0 };
  adaptive.set(id, entry);

  let lastPrecise = 0;
  let mode: 'precise' | 'approximate' | null = null;
  let highFailed = false;
  let lowFailed = false;
  let lastError = 0;

  const setMode = (next: 'precise' | 'approximate') => { if (mode !== next) { mode = next; bridge.emit('geo:mode', next); } };
  const report = (e: GeolocationPositionError) => {
    if (Date.now() - lastError < ERROR_REPEAT_MS) return; // one message per half minute, not one per retry
    lastError = Date.now();
    failure?.(e);
  };
  const startLow = () => {
    if (entry.low !== null) return;
    entry.low = api.watchPosition(
      (p) => {
        lowFailed = false;
        if (Date.now() - lastPrecise < PRECISE_FRESH_MS) return; // a precise fix is current: ignore the rough one
        setMode('approximate');
        success(p);
      },
      (e) => { lowFailed = true; if (e.code === 1 || highFailed) report(e); },
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 30000 },
    );
  };

  entry.high = api.watchPosition(
    (p) => { highFailed = false; lastPrecise = Date.now(); setMode('precise'); success(p); },
    (e) => {
      if (e.code === 1) { report(e); return; } // permission denied: nothing else will work either
      highFailed = true;
      startLow();
      if (lowFailed) report(e);
    },
    { ...options, enableHighAccuracy: true },
  );
  entry.timer = window.setTimeout(() => { if (!lastPrecise) startLow(); }, FALLBACK_AFTER_MS);
  return id;
}

export const geo = {
  watchPosition(success: Success, failure?: Failure, options?: PositionOptions): number {
    if (!isNative()) return watchAdaptive(success, failure, options);
    const id = ++counter;
    nativeIds.set(id, ''); // '' = starting, 'cancelled' = stopped before it finished starting
    void BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'ONEROUTE is sharing your location',
        backgroundMessage: 'Your convoy can see where you are. Stop the trip to turn this off.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 5,
      },
      (location, error) => {
        if (error) { failure?.(toError(error)); if (error.code === 'NOT_AUTHORIZED') void BackgroundGeolocation.openSettings(); return; }
        if (location) success(toPosition(location));
      },
    ).then((nativeId) => {
      if (nativeIds.get(id) === 'cancelled') { nativeIds.delete(id); void BackgroundGeolocation.removeWatcher({ id: nativeId }); }
      else nativeIds.set(id, nativeId);
    }).catch((err) => failure?.(toError({ message: String(err) })));
    return id;
  },

  clearWatch(id: number): void {
    const web = adaptive.get(id);
    if (web) {
      adaptive.delete(id);
      window.clearTimeout(web.timer);
      if (web.high !== null) navigator.geolocation.clearWatch(web.high);
      if (web.low !== null) navigator.geolocation.clearWatch(web.low);
      return;
    }
    const nativeId = nativeIds.get(id);
    if (nativeId === undefined) return;
    if (nativeId === '') { nativeIds.set(id, 'cancelled'); return; }
    nativeIds.delete(id);
    void BackgroundGeolocation.removeWatcher({ id: nativeId });
  },
};

/**
 * One-off position (trip creation, fuel stations): precise GPS first, then Wi-Fi/network location, so it also works on a laptop.
 * Rejects at once if the person denied permission, because the fallback could not succeed either.
 */
export function getPositionOnce(): Promise<GeolocationPosition> {
  const api = navigator.geolocation;
  const ask = (options: PositionOptions) => new Promise<GeolocationPosition>((resolve, reject) => api.getCurrentPosition(resolve, reject, options));
  return ask({ enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 })
    .catch((e: GeolocationPositionError) => (e.code === 1 ? Promise.reject(e) : ask({ enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 })));
}
