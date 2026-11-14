import i18n from '../i18n';
import { formatDistance } from './directions';

export interface Eta { seconds: number; meters: number }

const baseLanguage = (): string => (i18n.language || 'en').split('-')[0];

/** "2 h 15 min", "45 min", "3 h", "Under 1 min": in the current language. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60)); // whole minutes
  if (seconds > 0 && total === 0) return String(i18n.t('eta.under'));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0 && m > 0) return String(i18n.t('eta.h_m', { h, m }));
  if (h > 0) return String(i18n.t('eta.h', { h }));
  return String(i18n.t('eta.m', { m }));
}

/** The clock time you would arrive, for example "4:45 pm". */
export function arrivalClock(seconds: number, now: number = Date.now()): string {
  try {
    return new Date(now + seconds * 1000).toLocaleTimeString(`${baseLanguage()}-IN`, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(now + seconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
}

/** One line: "2 h 15 min · 64 km · Arrive 4:45 pm". Arriving shows "You have arrived". */
export function etaSummary(eta: Eta, now: number = Date.now()): string {
  if (eta.seconds <= 0 && eta.meters <= 30) return String(i18n.t('eta.arrived'));
  return [formatDuration(eta.seconds), formatDistance(eta.meters), String(i18n.t('eta.arrive', { time: arrivalClock(eta.seconds, now) }))].join(' · ');
}
