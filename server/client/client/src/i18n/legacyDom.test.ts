import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n, { i18nReady, setLanguage } from './index';
import { startLegacyTranslation } from './legacyDom';

let root: HTMLDivElement;
let stop: () => void;

beforeEach(async () => {
  await i18nReady;
  await setLanguage('en');
  root = document.createElement('div');
  root.innerHTML = `<h1>Live convoy</h1><button title="Close" aria-label="Close">Close</button><input placeholder="Search" value="Close"><textarea>Close</textarea><p id="note">Not a phrase we know</p>`;
  document.body.appendChild(root);
});
afterEach(() => { stop?.(); root.remove(); });

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('legacy translator', () => {
  it('leaves English untouched', async () => {
    stop = startLegacyTranslation(root); await settle();
    expect(root.querySelector('h1')!.textContent).toBe('Live convoy');
  });

  it('translates text and attributes, and leaves unknown text and typed text alone', async () => {
    stop = startLegacyTranslation(root);
    await setLanguage('hi'); await settle();
    expect(root.querySelector('h1')!.textContent).toBe('लाइव काफ़िला');
    const btn = root.querySelector('button')!;
    expect(btn.textContent).toBe('बंद करें');
    expect(btn.getAttribute('aria-label')).toBe('बंद करें');
    expect(root.querySelector('#note')!.textContent).toBe('Not a phrase we know');
    expect(root.querySelector('textarea')!.textContent).toBe('Close');                   // what a person typed is never rewritten
    expect((root.querySelector('input') as HTMLInputElement).value).toBe('Close');
    expect(root.querySelector('input')!.getAttribute('placeholder')).toBe('खोजें'); // placeholders are ours, so they translate
  });

  it('switches languages and returns to the original English', async () => {
    stop = startLegacyTranslation(root);
    await setLanguage('ml'); await settle();
    expect(root.querySelector('h1')!.textContent).toBe('തത്സമയ കോൺവോയ്');
    await setLanguage('hi'); await settle();
    expect(root.querySelector('h1')!.textContent).toBe('लाइव काफ़िला');
    await setLanguage('en'); await settle();
    expect(root.querySelector('h1')!.textContent).toBe('Live convoy');
    expect(root.querySelector('button')!.getAttribute('title')).toBe('Close');
  });

  it('translates text the engine adds later, and text it changes later', async () => {
    stop = startLegacyTranslation(root);
    await setLanguage('hi'); await settle();
    const banner = document.createElement('div');
    banner.innerHTML = '<b>Trip code copied</b>AB12';
    root.appendChild(banner); await settle();
    expect(banner.querySelector('b')!.textContent).toBe('ट्रिप कोड कॉपी हुआ');
    expect(banner.textContent).toContain('AB12'); // codes and names are never touched

    const h1 = root.querySelector('h1')!;
    h1.firstChild!.nodeValue = 'Members'; // the engine rewrites the heading
    await settle();
    expect(h1.textContent).toBe('सदस्य');
  });

  it('translates our buttons placed on a map, but never the map\'s own controls or attribution', async () => {
    root.innerHTML = '<div class="maplibregl-map"><button class="map-sat-fab">🗺 Map view</button><div class="maplibregl-control-container"><span>Close</span></div></div>';
    stop = startLegacyTranslation(root);
    await setLanguage('hi'); await settle();
    expect(root.querySelector('.map-sat-fab')!.textContent).toBe('🗺 नक्शा दृश्य');
    expect(root.querySelector('.maplibregl-control-container span')!.textContent).toBe('Close');
  });

  it('does not loop on its own edits', async () => {
    stop = startLegacyTranslation(root);
    await setLanguage('hi'); await settle();
    const before = root.innerHTML;
    await settle(); await settle();
    expect(root.innerHTML).toBe(before);
    expect(i18n.language).toBe('hi');
  });
});
