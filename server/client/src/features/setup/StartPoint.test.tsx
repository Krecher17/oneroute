import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18nReady, setLanguage } from '../../i18n';
import { bridge } from '../../lib/bridge';
import { StartPoint } from './StartPoint';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let places: unknown;
const urls: string[] = [];

beforeEach(async () => {
  await i18nReady; await setLanguage('en');
  document.body.innerHTML = '<div id="startSlot"></div>';
  urls.length = 0; places = [{ lat: 12.97, lon: 77.59, label: 'Bengaluru, Karnataka' }, { lat: 12.3, lon: 76.6, label: 'Mysuru, Karnataka' }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return places instanceof Response ? places : json(200, places); }));
  bridge.commands.setStart = vi.fn(); bridge.commands.getToken = vi.fn(() => 'tok');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = ''; delete bridge.commands.startStatus; delete bridge.commands.searchStart; });

const type = (value: string) => fireEvent.change(screen.getByLabelText('Starting point'), { target: { value } });
const status = () => (bridge.commands.startStatus as () => { typed: string; chosen: boolean })();

describe('StartPoint', () => {
  it('explains that empty means "where you are now"', () => {
    render(<StartPoint />);
    expect(screen.getByPlaceholderText('My current location')).toBeTruthy();
    expect(screen.getByText('Leave empty to start from where you are now.')).toBeTruthy();
  });

  it('searches, lets you pick a place, and hands its coordinates to the engine', async () => {
    render(<StartPoint />); type('bengal');
    fireEvent.click(screen.getByRole('button', { name: 'Search for a starting point' }));
    const pick = await screen.findByRole('button', { name: 'Bengaluru, Karnataka' });
    expect(urls[0]).toBe('/geocode?q=bengal');
    fireEvent.click(pick);
    expect(bridge.commands.setStart).toHaveBeenLastCalledWith({ lat: 12.97, lon: 77.59, label: 'Bengaluru, Karnataka' });
    expect(screen.getByRole('status').textContent).toContain('Starting from: Bengaluru, Karnataka');
    expect(status()).toEqual({ typed: 'Bengaluru, Karnataka', chosen: true });
  });

  it('a place typed but never picked is reported, so trip creation can ask for it', async () => {
    render(<StartPoint />); type('mysuru');
    expect(status()).toEqual({ typed: 'mysuru', chosen: false });
  });

  it('editing the text after picking drops the choice, and "use my current location" clears everything', async () => {
    render(<StartPoint />); type('bengal');
    fireEvent.click(screen.getByRole('button', { name: 'Search for a starting point' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bengaluru, Karnataka' }));
    type('Bengaluru, Karnataka and more');
    expect(bridge.commands.setStart).toHaveBeenLastCalledWith(null);
    expect(status().chosen).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Search for a starting point' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mysuru, Karnataka' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use my current location instead' }));
    expect(bridge.commands.setStart).toHaveBeenLastCalledWith(null);
    expect(status()).toEqual({ typed: '', chosen: false });
    expect((screen.getByLabelText('Starting point') as HTMLInputElement).value).toBe('');
  });

  it('shows "Did you mean…?" for fuzzy matches, and a message when nothing is found', async () => {
    places = [{ lat: 9.37, lon: 76.36, label: 'Ambalappuzha, India', approx: true }];
    render(<StartPoint />); type('ambapuzha');
    fireEvent.click(screen.getByRole('button', { name: 'Search for a starting point' }));
    await screen.findByText('Did you mean…?');
    places = [];
    type('qqzzxx'); fireEvent.click(screen.getByRole('button', { name: 'Search for a starting point' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No places found. Try a more specific name.');
  });

  it('shows a clear message when the search fails', async () => {
    places = json(500, { error: 'boom' });
    render(<StartPoint />); type('x');
    fireEvent.click(screen.getByRole('button', { name: 'Search for a starting point' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('is translated', async () => {
    render(<StartPoint />);
    await act(async () => { await setLanguage('hi'); });
    expect(screen.getByLabelText('शुरुआती स्थान')).toBeTruthy();
    expect(screen.getByPlaceholderText('मेरी मौजूदा लोकेशन')).toBeTruthy();
    await act(async () => { await setLanguage('en'); });
  });
});
