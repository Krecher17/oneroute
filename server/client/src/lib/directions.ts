import i18n from '../i18n';
import { speechLanguage } from './speech';

/** The parts of an OSRM step this file reads. */
export interface RouteStep { maneuver?: { type?: string; modifier?: string; exit?: number | string; location?: number[] } }

type Lng = string | undefined;
const tr = (key: string, lng: Lng, vars?: Record<string, unknown>): string =>
  String(i18n.t(key, { ...vars, ...(lng ? { lng } : {}) }));

// OSRM modifier -> translation key
const DIR_KEY: Record<string, string> = {
  left: 'left', right: 'right', straight: 'straight',
  'slight left': 'slightLeft', 'slight right': 'slightRight', 'sharp left': 'sharpLeft', 'sharp right': 'sharpRight',
};
const dirWord = (mod: string | undefined, lng: Lng, fallback = 'ahead'): string => tr(`nav.dir.${mod && DIR_KEY[mod] ? DIR_KEY[mod] : fallback}`, lng);

/** "450 m" / "2.4 km" in the current language's units. */
export function formatDistance(meters: number, lng?: Lng): string {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.max(0, Math.round(meters))} ${tr('nav.unit.m', lng)}`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} ${tr('nav.unit.km', lng)}`;
}

/** Short instruction shown on screen: "Turn right", "Keep left"... */
export function maneuverText(step: RouteStep | undefined, lng?: Lng): string {
  const m = step?.maneuver ?? {};
  const type = m.type || 'continue';
  const mod = m.modifier || '';
  switch (type) {
    case 'depart': return tr('nav.depart', lng);
    case 'arrive': return tr('nav.arrive', lng);
    case 'roundabout': case 'rotary': return mod ? tr('nav.roundaboutDir', lng, { dir: dirWord(mod, lng) }) : tr('nav.roundabout', lng);
    case 'merge': return mod ? tr('nav.mergeDir', lng, { dir: dirWord(mod, lng) }) : tr('nav.merge', lng);
    case 'fork': return tr('nav.fork', lng, { dir: dirWord(mod || 'straight', lng) });
    case 'end of road': return tr('nav.endOfRoad', lng, { dir: dirWord(mod, lng) });
    case 'turn':
      if (mod === 'uturn') return tr('nav.uturn', lng);
      return mod && DIR_KEY[mod] && mod !== 'straight' ? tr('nav.turn', lng, { dir: dirWord(mod, lng) }) : tr('nav.continue', lng);
    default: return tr('nav.continue', lng);
  }
}

/** The action part of a spoken prompt: "turn left", "take the second exit at the roundabout"... */
export function spokenAction(step: RouteStep | undefined, lng?: Lng): string {
  const m = step?.maneuver ?? {};
  const type = m.type || 'continue';
  const mod = m.modifier || '';
  const bent = !!mod && mod !== 'straight' && !!DIR_KEY[mod];
  const dir = dirWord(mod, lng);
  if (type === 'arrive') return tr('nav.spoken.arrive', lng);
  if (mod === 'uturn') return tr('nav.spoken.uturn', lng);
  if (type === 'roundabout' || type === 'rotary') {
    const n = Number(m.exit);
    return n >= 1 && n <= 8 ? tr('nav.spoken.roundaboutExit', lng, { ord: tr(`nav.ord.${n}`, lng) }) : tr('nav.spoken.roundabout', lng);
  }
  if (type === 'merge') return bent ? tr('nav.spoken.mergeDir', lng, { dir }) : tr('nav.spoken.merge', lng);
  if (type === 'fork') return tr('nav.spoken.fork', lng, { dir: dirWord(mod || 'straight', lng) });
  if (type === 'on ramp' || type === 'off ramp') return bent ? tr('nav.spoken.rampDir', lng, { dir }) : tr('nav.spoken.ramp', lng);
  if (type === 'end of road') return tr('nav.spoken.endOfRoad', lng, { dir: dirWord(mod, lng) });
  if (type === 'continue' || type === 'new name') return bent ? tr('nav.spoken.keepDir', lng, { dir }) : tr('nav.spoken.continue', lng);
  return bent ? tr('nav.spoken.turnDir', lng, { dir }) : tr('nav.spoken.continue', lng);
}

/** "2 kilometres" (rounded the way a person would say it). */
export function spokenDistance(meters: number, lng?: Lng): string {
  const km = meters / 1000;
  const r = km >= 5 ? Math.round(km) : Math.round(km * 2) / 2;
  return tr('nav.spoken.km', lng, { count: r });
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export type VoiceStage = 'far' | 'm500' | 'm200' | 'now';

/** The sentence to speak for one stage of a turn, in the language the device can actually speak. */
export function spokenPrompt(stage: VoiceStage, step: RouteStep, meters: number, lng: Lng = speechLanguage()): string {
  const arrive = step.maneuver?.type === 'arrive';
  const action = spokenAction(step, lng);
  if (stage === 'far') return tr('nav.spoken.far', lng, { distance: spokenDistance(meters, lng) });
  if (stage === 'now') return arrive ? tr('nav.spoken.arrived', lng) : upperFirst(tr('nav.spoken.now', lng, { action }));
  const d = Math.max(100, Math.min(stage === 'm500' ? 500 : 200, Math.round(meters / 50) * 50));
  return arrive ? tr('nav.spoken.destIn', lng, { d }) : tr('nav.spoken.inMetres', lng, { d, action });
}

export const spokenMissedTurn = (lng: Lng = speechLanguage()): string => tr('nav.spoken.missed', lng);
