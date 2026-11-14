import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18nReady, setLanguage } from '../../i18n';
import { bridge } from '../../lib/bridge';
import { AuthScreen } from './AuthScreen';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let routes: Record<string, (body: Record<string, unknown>) => Response>;
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeEach(async () => {
  await i18nReady; await setLanguage('en');
  localStorage.clear(); sessionStorage.clear();
  calls.length = 0;
  routes = { '/api/config': () => json(200, { googleClientId: null }) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    return (routes[url] ?? (() => json(404, {})))(body);
  }));
  bridge.commands.storeToken = vi.fn();
  bridge.commands.enterApp = vi.fn();
  bridge.commands.clearToken = vi.fn();
  bridge.markReady();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('AuthScreen', () => {
  it('validates before it calls the server', async () => {
    render(<AuthScreen onSignedIn={() => {}} />);
    type('Email address', 'nope');
    fireEvent.click(screen.getByRole('button', { name: /^Sign in/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a valid email address.');
    expect(calls.some((c) => c.url === '/api/login')).toBe(false);
  });

  it('shows the server error in the chosen language and re-translates when the language changes', async () => {
    routes['/api/login'] = () => json(401, { error: 'Wrong email or password.', code: 'wrong_credentials' });
    render(<AuthScreen onSignedIn={() => {}} />);
    type('Email address', 'a@b.co'); type('Password', 'secret123');
    fireEvent.click(screen.getByRole('button', { name: /^Sign in/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Wrong email or password.'));
    await act(async () => { await setLanguage('hi'); });
    expect(screen.getByRole('alert').textContent).toBe('ईमेल या पासवर्ड गलत है।');
    await act(async () => { await setLanguage('en'); });
  });

  it('signs in: stores the token, hands the user to the engine, then leaves', async () => {
    routes['/api/login'] = () => json(200, { token: 't'.repeat(64), user: { id: 'u1', name: 'Asha' } });
    const done = vi.fn();
    render(<AuthScreen onSignedIn={done} />);
    type('Email address', 'a@b.co'); type('Password', 'secret123');
    fireEvent.click(screen.getByRole('button', { name: /^Sign in/ }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(bridge.commands.storeToken).toHaveBeenCalledWith('t'.repeat(64), true);
    expect(bridge.commands.enterApp).toHaveBeenCalledWith({ id: 'u1', name: 'Asha' });
  });

  it('sign-up needs the consent box and an 8+ character password', async () => {
    render(<AuthScreen onSignedIn={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    type('Your name', 'Asha'); type('Email address', 'a@b.co'); type(/^Password/, 'short');
    fireEvent.click(screen.getByRole('button', { name: /^Create account/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Use a password with at least 8 characters.');
    type(/^Password/, 'longenough1');
    fireEvent.click(screen.getByRole('button', { name: /^Create account/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Please tick the box to agree to the Terms and Privacy Policy.');
    expect(calls.some((c) => c.url === '/api/signup')).toBe(false);
  });

  it('skips the form when a saved login is still valid', async () => {
    localStorage.setItem('oneroute-token', 'k'.repeat(64));
    routes['/api/me'] = () => json(200, { user: { id: 'u2', name: 'Ravi' } });
    const done = vi.fn();
    render(<AuthScreen onSignedIn={done} />);
    expect(screen.getByRole('heading').textContent).toBe('Signing you in…');
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(bridge.commands.enterApp).toHaveBeenCalledWith({ id: 'u2', name: 'Ravi' });
  });

  it('shows the sign-in form again, and clears the token, when the saved login was revoked', async () => {
    localStorage.setItem('oneroute-token', 'k'.repeat(64));
    routes['/api/me'] = () => json(401, { error: 'Please sign in first.', code: 'unauthorized' });
    render(<AuthScreen onSignedIn={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Your session ended. Please sign in again.'));
    expect(bridge.commands.clearToken).toHaveBeenCalled();
  });
});
