import { useEffect } from 'react';
import markup from './markup.html?raw';
import { startLegacy } from './engine.js';
import { startLegacyTranslation } from '../i18n/legacyDom';

/**
 * Hosts the screens that have not been migrated to React yet. The markup is rendered once (React never
 * re-renders it) and the original engine drives it. Each migrated screen removes a piece of this.
 */
export function LegacyApp() {
  useEffect(() => {
    const root = document.getElementById('legacy-root');
    const stopTranslating = root ? startLegacyTranslation(root) : undefined;
    startLegacy();
    return () => stopTranslating?.();
  }, []);
  return <div id="legacy-root" dangerouslySetInnerHTML={{ __html: markup }} />;
}
