import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { i18nReady, setLanguage } from '../../i18n';
import { bridge, type EngineState } from '../../lib/bridge';
import { TurnCard } from './TurnCard';
import { GpsHelp } from '../location/GpsHelp';

const base: EngineState = {
  inTrip: true, tripCode: 'AB12', speedKmh: null, gpsOk: false, halted: false, sos: false, navVoice: true, recording: false, connected: true,
  gpsMode: null, gpsError: null, nav: null, convoy: { count: 1, myStatus: 'ok', issues: [] }, incomingSos: [],
};
const push = (patch: Partial<EngineState> = {}) => act(() => { bridge.emit('state', { ...base, ...patch }); });

beforeEach(async () => {
  await i18nReady; await setLanguage('en');
  document.body.innerHTML = '<div id="turnSlot"></div><div id="gpsHelpSlot"></div>';
  bridge.commands.openNavigation = vi.fn(); bridge.commands.retryGps = vi.fn(); bridge.commands.manualLocation = vi.fn();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true }); // a real browser treats http://localhost as secure
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('TurnCard', () => {
  it('stays out of the way until a trip is running', () => {
    render(<TurnCard />); push({ inTrip: false });
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('says what it is waiting for, then shows the next turn, and opens navigation on tap', () => {
    render(<TurnCard />); push();
    expect(screen.getByRole('button').textContent).toContain('Waiting for GPS');
    push({ gpsOk: true });
    expect(screen.getByRole('button').textContent).toContain('Preparing directions');
    push({ gpsOk: true, nav: { icon: '↱', text: 'Turn right', road: 'NH 275', distance: '450 m', arrive: false, preview: false } });
    const card = screen.getByRole('button', { name: 'Open full-screen navigation' });
    expect(card.textContent).toContain('450 m'); expect(card.textContent).toContain('Turn right'); expect(card.textContent).toContain('NH 275');
    fireEvent.click(card);
    expect(bridge.commands.openNavigation).toHaveBeenCalled();
  });
  it('shows the time to destination under the turn, and it shrinks as you get closer', () => {
    render(<TurnCard />);
    const nav = (seconds: number, meters: number) => ({ icon: '↱', text: 'Turn right', road: '', distance: '450 m', arrive: false, eta: { seconds, meters } });
    push({ gpsOk: true, nav: nav(8100, 64000) });
    expect(screen.getByRole('button').textContent).toContain('2 h 15 min');
    expect(screen.getByRole('button').textContent).toContain('64 km');
    push({ gpsOk: true, nav: nav(3000, 22000) });
    expect(screen.getByRole('button').textContent).toContain('50 min');
    expect(screen.getByRole('button').textContent).not.toContain('2 h');
  });
  it('marks a preview as a preview', () => {
    render(<TurnCard />); push({ nav: { icon: '⬆', text: 'Start driving', road: '', distance: '64 km', arrive: false, preview: true } });
    expect(screen.getByRole('button').textContent).toContain('Preview from the trip start');
  });
  it('speaks the person\'s language', async () => {
    render(<TurnCard />); push({ gpsOk: true, nav: { icon: '↱', text: 'दाएँ मुड़ें', road: '', distance: '2.4 किमी', arrive: false } });
    vi.useRealTimers();
    await act(async () => { await setLanguage('hi'); });
    expect(screen.getByRole('button', { name: 'फ़ुल-स्क्रीन नेविगेशन खोलें' })).toBeTruthy();
    await act(async () => { await setLanguage('en'); });
  });
});

describe('GpsHelp', () => {
  const wait = (s: number) => act(() => { vi.advanceTimersByTime(s * 1000); });
  const permission = (state: string) => Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state }) } });

  it('appears only after 12 seconds without a location', async () => {
    permission('granted'); render(<GpsHelp />); push(); await wait(8);
    expect(screen.queryByRole('alert')).toBeNull();
    await wait(5); expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('disappears as soon as a location arrives', async () => {
    permission('granted'); render(<GpsHelp />); push(); await wait(13);
    expect(screen.getByRole('alert')).toBeTruthy();
    push({ gpsOk: true });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('explains a blocked permission', async () => {
    permission('denied'); render(<GpsHelp />); push(); await wait(13);
    expect(screen.getByRole('alert').textContent).toContain('Location is blocked for this site');
  });
  it('explains a pending permission prompt', async () => {
    permission('prompt'); render(<GpsHelp />); push(); await wait(13);
    expect(screen.getByRole('alert').textContent).toContain('waiting for your permission');
  });
  it('explains a device that is not sharing a location, and mentions the Windows setting', async () => {
    permission('granted'); render(<GpsHelp />); push(); await wait(13);
    expect(screen.getByRole('alert').textContent).toContain('Privacy & security');
  });
  it('treats a permission-denied error from the browser as blocked', async () => {
    permission('granted'); render(<GpsHelp />); push({ gpsError: 1 }); await wait(13);
    expect(screen.getByRole('alert').textContent).toContain('blocked');
  });
  it('explains when the page is not on a secure (https) address', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    permission('granted'); render(<GpsHelp />); push(); await wait(13);
    expect(screen.getByRole('alert').textContent).toContain('secure (https) address');
  });
  it('offers Try again and Set my location', async () => {
    permission('granted'); render(<GpsHelp />); push(); await wait(13);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(bridge.commands.retryGps).toHaveBeenCalled();
    push(); await wait(13);
    fireEvent.click(screen.getByRole('button', { name: 'Set my location on the map' }));
    expect(bridge.commands.manualLocation).toHaveBeenCalled();
  });
});
