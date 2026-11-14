import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'oneroute-theme';
const META_COLOR: Record<Theme, string> = { dark: '#17191d', light: '#f3f1ec' };

const systemTheme = (): Theme => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
const saved = (): Theme | null => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; } };

export const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

const listeners = new Set<() => void>();
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLOR[theme]);
  listeners.forEach((l) => l());
}

/** The person's choice, remembered on this device. */
export function setTheme(theme: Theme): void {
  try { localStorage.setItem(KEY, theme); } catch { /* private mode: still works for this visit */ }
  applyTheme(theme);
}

/** Saved choice, else the device's own light/dark setting (and keep following it until the person picks). */
export function initTheme(): void {
  applyTheme(saved() ?? systemTheme());
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (!saved()) applyTheme(systemTheme()); });
}

export function useTheme(): Theme {
  return useSyncExternalStore((notify) => { listeners.add(notify); return () => listeners.delete(notify); }, currentTheme);
}
