import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, currentTheme, initTheme, setTheme } from './theme';

const prefer = (scheme: 'light' | 'dark') => {
  window.matchMedia = ((query: string) => ({ matches: query.includes('light') ? scheme === 'light' : scheme === 'dark', media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  localStorage.clear(); delete document.documentElement.dataset.theme;
  document.head.innerHTML = '<meta name="theme-color" content="#17191d">';
});
afterEach(() => { delete document.documentElement.dataset.theme; });

describe('light / dark theme', () => {
  it('follows the device setting when nothing has been chosen', () => {
    prefer('light'); initTheme(); expect(currentTheme()).toBe('light');
    prefer('dark'); initTheme(); expect(currentTheme()).toBe('dark');
  });

  it('a saved choice beats the device setting', () => {
    prefer('dark'); localStorage.setItem('oneroute-theme', 'light'); initTheme();
    expect(currentTheme()).toBe('light');
  });

  it('setTheme applies, remembers, and updates the browser colour', () => {
    prefer('dark'); initTheme();
    setTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('oneroute-theme')).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#f3f1ec');
    setTheme('dark');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#17191d');
  });

  it('ignores a corrupt saved value', () => {
    prefer('dark'); localStorage.setItem('oneroute-theme', 'purple'); initTheme();
    expect(currentTheme()).toBe('dark');
  });

  it('applyTheme alone does not save anything (so following the device keeps working)', () => {
    applyTheme('light'); expect(localStorage.getItem('oneroute-theme')).toBeNull();
  });
});
