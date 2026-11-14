import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { i18nReady, setLanguage } from '../../i18n';
import { bridge, type EngineState } from '../../lib/bridge';
import { DrivingMode } from './DrivingMode';

const base: EngineState = {
  inTrip: true, tripCode: 'AB12', speedKmh: 64, gpsOk: true, halted: false, sos: false, navVoice: true, recording: false, connected: true,
  nav: { icon: '↱', text: 'Turn right', road: 'NH 275', distance: '450 m', arrive: false },
  convoy: { count: 3, myStatus: 'ok', issues: [] }, incomingSos: [],
};
const push = (patch: Partial<EngineState> = {}) => act(() => { bridge.emit('state', { ...base, ...patch }); });

beforeEach(async () => {
  await i18nReady; await setLanguage('en');
  localStorage.clear();
  document.body.innerHTML = '<div id="drivingSlot"></div>';
  bridge.commands.sos = vi.fn(); bridge.commands.halt = vi.fn(); bridge.commands.voice = vi.fn();
  bridge.commands.navVoice = vi.fn(); bridge.commands.navData = vi.fn();
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ''; });

const open = () => { render(<DrivingMode />, { container: document.body.appendChild(document.createElement('div')) }); push(); };

describe('DrivingMode', () => {
  it('offers the button only while a trip is running', () => {
    render(<DrivingMode />); act(() => { bridge.emit('state', { ...base, inTrip: false }); });
    expect(screen.queryByRole('button', { name: 'Driving mode' })).toBeNull();
    push();
    expect(screen.getByRole('button', { name: 'Driving mode' })).toBeTruthy();
  });

  it('shows speed, next turn and convoy status, and turns on turn-by-turn data', () => {
    open(); fireEvent.click(screen.getByRole('button', { name: 'Driving mode' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('64');
    expect(dialog.textContent).toContain('450 m');
    expect(dialog.textContent).toContain('Turn right');
    expect(dialog.textContent).toContain('Everyone is on route');
    expect(bridge.commands.navData).toHaveBeenCalledWith(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bridge.commands.navData).toHaveBeenLastCalledWith(false);
  });

  it('names who is behind or off route', () => {
    open(); fireEvent.click(screen.getByRole('button', { name: 'Driving mode' }));
    push({ convoy: { count: 3, myStatus: 'ok', issues: [{ name: 'Ravi', status: 'behind', gapKm: 2.46 }] } });
    expect(screen.getByRole('dialog').textContent).toContain('Ravi is 2.5 km behind');
    push({ convoy: { count: 3, myStatus: 'ok', issues: [{ name: 'Meera', status: 'off', gapKm: 0 }] } });
    expect(screen.getByRole('dialog').textContent).toContain('Meera is off route');
  });

  it('SOS needs a deliberate hold: a tap does nothing, a hold sends once, release does not cancel it', () => {
    open(); fireEvent.click(screen.getByRole('button', { name: 'Driving mode' }));
    const sos = screen.getByRole('button', { name: /SOS/ });

    fireEvent.pointerDown(sos); act(() => { vi.advanceTimersByTime(300); }); fireEvent.pointerUp(sos); fireEvent.click(sos, { detail: 1 });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(bridge.commands.sos).not.toHaveBeenCalled();

    fireEvent.pointerDown(sos); act(() => { vi.advanceTimersByTime(1300); });
    expect(bridge.commands.sos).toHaveBeenCalledTimes(1);
    push({ sos: true });                       // the engine confirms the SOS
    fireEvent.pointerUp(sos); fireEvent.click(sos, { detail: 1 }); // lifting the finger fires a click
    expect(bridge.commands.sos).toHaveBeenCalledTimes(1);          // ...which must not cancel it

    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.click(screen.getByRole('button', { name: /SOS/ }), { detail: 1 });  // a later deliberate tap cancels
    expect(bridge.commands.sos).toHaveBeenCalledTimes(2);
  });

  it('shows a loud alert when another driver sends SOS', () => {
    open(); fireEvent.click(screen.getByRole('button', { name: 'Driving mode' }));
    push({ incomingSos: ['Meera'] });
    expect(screen.getByRole('alert').textContent).toContain('Meera needs help');
  });

  it('halt, voice and mute call the engine', () => {
    open(); fireEvent.click(screen.getByRole('button', { name: 'Driving mode' }));
    fireEvent.click(screen.getByRole('button', { name: /Halt/ }));
    fireEvent.click(screen.getByRole('button', { name: /Voice/ }));
    fireEvent.click(screen.getByRole('button', { name: /Mute/ }));
    expect(bridge.commands.halt).toHaveBeenCalled();
    expect(bridge.commands.voice).toHaveBeenCalled();
    expect(bridge.commands.navVoice).toHaveBeenCalledWith(false);
  });

  it('switches itself on after 8 s above 20 km/h, but only if the person allowed it, and not after closing it by hand', () => {
    open();
    push({ speedKmh: 40 });
    act(() => { vi.advanceTimersByTime(12000); });
    expect(screen.queryByRole('dialog')).toBeNull();                 // auto is off by default

    fireEvent.click(screen.getByRole('button', { name: 'Driving mode' }));
    fireEvent.click(screen.getByRole('checkbox'));                    // allow automatic switch-on
    fireEvent.keyDown(window, { key: 'Escape' });                     // person closes it by hand
    act(() => { vi.advanceTimersByTime(12000); });
    expect(screen.queryByRole('dialog')).toBeNull();                  // respects the manual close

    act(() => { bridge.emit('state', { ...base, inTrip: false }); }); // trip ends
    push({ speedKmh: 40 });                                           // next trip
    act(() => { vi.advanceTimersByTime(9000); });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('is fully translated (Hindi)', async () => {
    open(); fireEvent.click(screen.getByRole('button', { name: 'Driving mode' }));
    vi.useRealTimers();
    await act(async () => { await setLanguage('hi'); });
    expect(screen.getByRole('dialog').textContent).toContain('सभी सही रास्ते पर हैं');
    expect(screen.getByRole('dialog').textContent).toContain('SOS भेजने के लिए दबाए रखें');
    await act(async () => { await setLanguage('en'); });
  });
});
