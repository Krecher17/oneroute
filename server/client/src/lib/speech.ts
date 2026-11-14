import i18n from '../i18n';

// Locale tags the browser's voices use. Indian English is the default voice for English prompts.
const LOCALES: Record<string, string> = { en: 'en-IN', hi: 'hi-IN', ml: 'ml-IN', ta: 'ta-IN', kn: 'kn-IN', te: 'te-IN' };

const baseOf = (code: string | undefined): string => (code ?? 'en').split('-')[0].toLowerCase();

/** True when this device has a text-to-speech voice for the language. */
export function hasVoiceFor(base: string): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  return window.speechSynthesis.getVoices().some((v) => baseOf(v.lang) === base);
}

/**
 * The language to speak directions in. It is the person's language only if the device has a voice for it;
 * otherwise English, so the words and the voice always match (a Malayalam sentence read by an English voice is noise).
 */
export function speechLanguage(): string {
  const base = baseOf(i18n.language);
  return base === 'en' || !hasVoiceFor(base) ? 'en' : base;
}

export const speechLocale = (): string => LOCALES[speechLanguage()] ?? 'en-IN';

// Browsers load their voice list lazily: ask once so the list is ready by the time the first prompt is needed.
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  try { window.speechSynthesis.getVoices(); window.speechSynthesis.addEventListener?.('voiceschanged', () => undefined); } catch { /* unsupported */ }
}
