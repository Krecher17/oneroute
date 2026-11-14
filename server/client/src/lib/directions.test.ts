import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18nReady, setLanguage } from '../i18n';
import { formatDistance, maneuverText, spokenAction, spokenDistance, spokenMissedTurn, spokenPrompt, type RouteStep } from './directions';

const step = (type: string, modifier?: string, extra: Record<string, unknown> = {}): RouteStep => ({ maneuver: { type, modifier, ...extra } });

beforeEach(async () => { await i18nReady; await setLanguage('en'); });
afterEach(async () => { await setLanguage('en'); });

describe('directions in English (same wording the app always had)', () => {
  it('on-screen instructions', () => {
    expect(maneuverText(step('turn', 'left'))).toBe('Turn left');
    expect(maneuverText(step('turn', 'slight right'))).toBe('Turn slightly right');
    expect(maneuverText(step('turn', 'sharp left'))).toBe('Turn sharp left');
    expect(maneuverText(step('turn', 'uturn'))).toBe('Make a U-turn');
    expect(maneuverText(step('depart'))).toBe('Start driving');
    expect(maneuverText(step('arrive'))).toBe('You have arrived');
    expect(maneuverText(step('fork', 'left'))).toBe('Keep left');
    expect(maneuverText(step('merge'))).toBe('Merge');
    expect(maneuverText(step('roundabout'))).toBe('Enter the roundabout');
    expect(maneuverText(step('continue'))).toBe('Continue straight');
    expect(maneuverText(undefined)).toBe('Continue straight');
  });

  it('spoken actions', () => {
    expect(spokenAction(step('turn', 'left'), 'en')).toBe('turn left');
    expect(spokenAction(step('turn', 'slight right'), 'en')).toBe('turn slightly right');
    expect(spokenAction(step('roundabout', undefined, { exit: 2 }), 'en')).toBe('take the second exit at the roundabout');
    expect(spokenAction(step('roundabout'), 'en')).toBe('enter the roundabout');
    expect(spokenAction(step('on ramp', 'right'), 'en')).toBe('take the ramp on the right');
    expect(spokenAction(step('end of road', 'left'), 'en')).toBe('turn left at the end of the road');
    expect(spokenAction(step('new name'), 'en')).toBe('continue straight');
    expect(spokenAction(step('arrive'), 'en')).toBe('you will arrive at your destination');
  });

  it('prompts for each stage of a turn', () => {
    const left = step('turn', 'left');
    expect(spokenPrompt('far', left, 2300, 'en')).toBe('Continue straight for 2.5 kilometres.');
    expect(spokenPrompt('far', left, 1000, 'en')).toBe('Continue straight for 1 kilometre.');
    expect(spokenPrompt('m500', left, 480, 'en')).toBe('In 500 metres, turn left.');
    expect(spokenPrompt('m200', left, 190, 'en')).toBe('In 200 metres, turn left.');
    expect(spokenPrompt('now', left, 50, 'en')).toBe('Turn left now.');
    expect(spokenPrompt('m500', step('arrive'), 500, 'en')).toBe('Your destination is in 500 metres.');
    expect(spokenPrompt('now', step('arrive'), 20, 'en')).toBe('You have arrived.');
    expect(spokenMissedTurn('en')).toBe('You have missed your turn. Finding a route to rejoin.');
  });

  it('distances', () => {
    expect(formatDistance(450)).toBe('450 m');
    expect(formatDistance(2400)).toBe('2.4 km');
    expect(formatDistance(64000)).toBe('64 km');
    expect(formatDistance(NaN)).toBe('—');
    expect(spokenDistance(7200, 'en')).toBe('7 kilometres');
  });
});

describe('directions in other languages', () => {
  it('Hindi on-screen text and units follow the language', async () => {
    await setLanguage('hi');
    expect(maneuverText(step('turn', 'right'))).toBe('दाएँ मुड़ें');
    expect(maneuverText(step('turn', 'slight left'))).toBe('थोड़ा बाएँ मुड़ें');
    expect(formatDistance(2400)).toBe('2.4 किमी');
    expect(formatDistance(450)).toBe('450 मी');
  });

  it('spoken prompts use the language asked for, whatever the screen language is', async () => {
    await setLanguage('ml');
    expect(spokenPrompt('m200', step('turn', 'left'), 200, 'ml')).toBe('200 മീറ്റർ കഴിഞ്ഞ്, ഇടത്തേക്ക് തിരിയുക.');
    expect(spokenPrompt('m200', step('turn', 'left'), 200, 'en')).toBe('In 200 metres, turn left.'); // no Malayalam voice: stay consistent in English
    expect(spokenPrompt('far', step('turn', 'left'), 3000, 'hi')).toBe('3 किलोमीटर तक सीधे चलते रहें।');
  });

  it('every language builds every kind of prompt without leaving a {{placeholder}} behind', async () => {
    const steps = [step('turn', 'left'), step('turn', 'sharp right'), step('roundabout', undefined, { exit: 3 }), step('fork', 'right'), step('merge', 'left'), step('on ramp', 'right'), step('end of road', 'left'), step('arrive'), step('continue')];
    for (const lng of ['en', 'hi', 'ml', 'ta', 'kn', 'te']) {
      await setLanguage(lng as 'en');
      for (const st of steps) {
        for (const stage of ['far', 'm500', 'm200', 'now'] as const) {
          const text = spokenPrompt(stage, st, stage === 'far' ? 2000 : 300, lng);
          expect(text, `${lng} ${st.maneuver?.type} ${stage}`).not.toMatch(/\{\{|\}\}|nav\./);
          expect(text.length).toBeGreaterThan(3);
        }
        expect(maneuverText(st, lng)).not.toMatch(/\{\{|\}\}|nav\./);
      }
      expect(spokenMissedTurn(lng)).not.toMatch(/\{\{|nav\./);
    }
  });
});
