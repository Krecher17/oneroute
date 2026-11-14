import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { i18nReady, setLanguage } from '../i18n';
import { applyTheme, currentTheme } from '../lib/theme';
import { ThemeToggle } from './ThemeToggle';

beforeEach(async () => { await i18nReady; await setLanguage('en'); localStorage.clear(); applyTheme('dark'); });
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; });

describe('ThemeToggle', () => {
  it('offers the other mode, switches on tap, and offers the way back', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(currentTheme()).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(currentTheme()).toBe('dark');
  });

  it('the compact version has no visible text but keeps its accessible name', () => {
    render(<ThemeToggle variant="icon" />);
    const button = screen.getByRole('button', { name: 'Switch to light mode' });
    expect(button.textContent).toBe('');
  });

  it('is translated', async () => {
    render(<ThemeToggle />);
    await act(async () => { await setLanguage('hi'); });
    expect(screen.getByRole('button', { name: 'हल्का मोड चालू करें' })).toBeTruthy();
    await act(async () => { await setLanguage('en'); });
  });
});
