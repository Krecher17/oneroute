import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18nReady, setLanguage } from '../i18n';
import { arrivalClock, etaSummary, formatDuration } from './eta';

beforeEach(async () => { await i18nReady; await setLanguage('en'); });
afterEach(async () => { await setLanguage('en'); });

describe('time to destination', () => {
  it('formats durations in whole minutes', () => {
    expect(formatDuration(8100)).toBe('2 h 15 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(2700)).toBe('45 min');
    expect(formatDuration(95)).toBe('2 min');
    expect(formatDuration(20)).toBe('Under 1 min');
    expect(formatDuration(0)).toBe('0 min');
  });

  it('gets shorter as you get closer', () => {
    const far = formatDuration(5400), nearer = formatDuration(4800), near = formatDuration(600);
    expect([far, nearer, near]).toEqual(['1 h 30 min', '1 h 20 min', '10 min']);
  });

  it('builds the arrival clock from now plus the remaining time', () => {
    const now = new Date('2026-11-12T10:00:00+05:30').getTime();
    expect(arrivalClock(5400, now)).toBe(new Date(now + 5400 * 1000).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }));
  });

  it('summarises duration, distance and arrival, and says so when you have arrived', () => {
    const now = new Date('2026-11-12T10:00:00+05:30').getTime();
    const line = etaSummary({ seconds: 8100, meters: 64000 }, now);
    expect(line).toContain('2 h 15 min'); expect(line).toContain('64 km'); expect(line).toContain('Arrive ');
    expect(etaSummary({ seconds: 0, meters: 10 }, now)).toBe('You have arrived');
  });

  it('speaks the person\'s language', async () => {
    await setLanguage('hi');
    expect(formatDuration(8100)).toBe('2 घं 15 मि');
    expect(etaSummary({ seconds: 600, meters: 5200 })).toContain('5.2 किमी');
    await setLanguage('ml');
    expect(formatDuration(3600)).toBe('1 മ');
  });
});
