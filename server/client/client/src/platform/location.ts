import { registerPlugin } from '@capacitor/core';
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

export const geo = {
  watchPosition(success: Success, failure?: Failure, options?: PositionOptions): number {
    if (!isNative()) return navigator.geolocation.watchPosition(success, failure, options);
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
    if (!isNative()) { navigator.geolocation.clearWatch(id); return; }
    const nativeId = nativeIds.get(id);
    if (nativeId === undefined) return;
    if (nativeId === '') { nativeIds.set(id, 'cancelled'); return; }
    nativeIds.delete(id);
    void BackgroundGeolocation.removeWatcher({ id: nativeId });
  },
};
