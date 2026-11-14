import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridge } from '../lib/bridge';
import { geo } from './location';

type Cb = (p: GeolocationPosition) => void;
type Err = (e: GeolocationPositionError) => void;
interface Watch { id: number; ok: Cb; err: Err; opts: PositionOptions }

let watches: Watch[];
let cleared: number[];
const pos = (lat: number): GeolocationPosition => ({ coords: { latitude: lat, longitude: 77, accuracy: 30, speed: null, heading: null, altitude: null, altitudeAccuracy: null }, timestamp: Date.now() } as unknown as GeolocationPosition);
const fail = (code: number): GeolocationPositionError => ({ code, message: 'x', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
const precise = () => watches.find((w) => w.opts.enableHighAccuracy)!;
const rough = () => watches.find((w) => !w.opts.enableHighAccuracy);

beforeEach(() => {
  vi.useFakeTimers();
  watches = []; cleared = [];
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    watchPosition: (ok: Cb, err: Err, opts: PositionOptions) => { const w = { id: watches.length + 100, ok, err, opts }; watches.push(w); return w.id; },
    clearWatch: (id: number) => { cleared.push(id); },
  } });
});
afterEach(() => { vi.useRealTimers(); });

describe('laptop-friendly location', () => {
  it('uses precise GPS when it answers and never starts the network watch', () => {
    const got = vi.fn(); const modes: string[] = []; const off = bridge.on<string>('geo:mode', (m) => modes.push(m));
    geo.watchPosition(got, vi.fn());
    precise().ok(pos(1));
    vi.advanceTimersByTime(10000);
    expect(got).toHaveBeenCalledTimes(1);
    expect(rough()).toBeUndefined();
    expect(modes.at(-1)).toBe('precise'); off();
  });

  it('falls back to network location after 6 s of silence (a laptop with no GPS chip)', () => {
    const got = vi.fn(); const modes: string[] = []; const off = bridge.on<string>('geo:mode', (m) => modes.push(m));
    geo.watchPosition(got, vi.fn());
    expect(rough()).toBeUndefined();
    vi.advanceTimersByTime(6100);
    expect(rough()).toBeDefined();
    rough()!.ok(pos(2));
    expect(got).toHaveBeenCalledTimes(1);
    expect(modes.at(-1)).toBe('approximate'); off();
  });

  it('falls back at once when the precise request fails, without bothering the person', () => {
    const got = vi.fn(); const failed = vi.fn();
    geo.watchPosition(got, failed);
    precise().err(fail(2));
    expect(rough()).toBeDefined();
    rough()!.ok(pos(3));
    expect(got).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('prefers precise fixes over rough ones once both exist', () => {
    const got = vi.fn();
    geo.watchPosition(got, vi.fn());
    vi.advanceTimersByTime(6100);
    rough()!.ok(pos(10));                 // rough fix first
    precise().ok(pos(11));                // precise arrives
    got.mockClear();
    rough()!.ok(pos(12));                 // a later rough fix must be ignored while precise is fresh
    expect(got).not.toHaveBeenCalled();
    vi.advanceTimersByTime(21000);        // precise went quiet: rough is used again
    rough()!.ok(pos(13));
    expect(got).toHaveBeenCalledTimes(1);
  });

  it('reports permission denied straight away, and a total failure only when both ways failed (once per 30 s)', () => {
    const failed = vi.fn();
    const first = geo.watchPosition(vi.fn(), failed);
    precise().err(fail(1));
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].code).toBe(1);
    geo.clearWatch(first); // stop the first scenario's watches and timer so they cannot leak into the next one

    const failed2 = vi.fn();
    watches = [];
    geo.watchPosition(vi.fn(), failed2);
    vi.advanceTimersByTime(6100);
    rough()!.err(fail(2));                 // network location failed first
    expect(failed2).not.toHaveBeenCalled();
    precise().err(fail(3));                // now both have failed
    expect(failed2).toHaveBeenCalledTimes(1);
    precise().err(fail(3));
    expect(failed2).toHaveBeenCalledTimes(1);  // not repeated within 30 s
    vi.advanceTimersByTime(31000);
    precise().err(fail(3));
    expect(failed2).toHaveBeenCalledTimes(2);
  });

  it('clearWatch stops both watches and the pending fallback', () => {
    const id = geo.watchPosition(vi.fn(), vi.fn());
    vi.advanceTimersByTime(6100);
    const ids = watches.map((w) => w.id);
    geo.clearWatch(id);
    expect(cleared.sort()).toEqual(ids.sort());
    const before = watches.length;
    vi.advanceTimersByTime(20000);
    expect(watches.length).toBe(before);
  });
});
