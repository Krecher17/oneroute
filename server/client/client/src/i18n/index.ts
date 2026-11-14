import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'ml', name: 'മലയാളം' },
  { code: 'ta', name: 'தமிழ்' },
  { code: 'kn', name: 'ಕನ್ನಡ' },
  { code: 'te', name: 'తెలుగు' },
] as const;
export type LanguageCode = (typeof LANGUAGES)[number]['code'];

const STORAGE_KEY = 'oneroute-lang';

// English ships in the main bundle; other languages are downloaded only when someone uses them.
const loaders: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  hi: () => import('./locales/hi.json'),
  ml: () => import('./locales/ml.json'),
  ta: () => import('./locales/ta.json'),
  kn: () => import('./locales/kn.json'),
  te: () => import('./locales/te.json'),
};

async function loadBundle(code: string): Promise<void> {
  if (code === 'en' || i18n.hasResourceBundle(code, 'translation')) return;
  const load = loaders[code];
  if (!load) return;
  const mod = await load();
  i18n.addResourceBundle(code, 'translation', mod.default, true, true);
}

const baseOf = (code: string | undefined): LanguageCode => {
  const base = (code ?? 'en').split('-')[0].toLowerCase();
  return (LANGUAGES.some((l) => l.code === base) ? base : 'en') as LanguageCode;
};

/** Switches language and remembers the choice. */
export async function setLanguage(code: LanguageCode): Promise<void> {
  await loadBundle(code);
  await i18n.changeLanguage(code);
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* private mode */ }
}

i18n.on('languageChanged', (lng) => { document.documentElement.lang = baseOf(lng); });

/** Resolves when the saved/browser language is loaded, so the first paint is already in the right language. */
export const i18nReady: Promise<void> = (async () => {
  await i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: { en: { translation: en } },
      fallbackLng: 'en',
      supportedLngs: LANGUAGES.map((l) => l.code),
      nonExplicitSupportedLngs: true,
      load: 'languageOnly',
      interpolation: { escapeValue: false }, // React escapes; our strings contain no HTML
      detection: { order: ['localStorage', 'navigator'], lookupLocalStorage: STORAGE_KEY, caches: [] },
      returnNull: false,
      showSupportNotice: false,
    });
  // i18n.language is what was detected; resolvedLanguage would still say 'en' because only English is loaded yet.
  const wanted = baseOf(i18n.language);
  await loadBundle(wanted);
  await i18n.changeLanguage(wanted);
})();

export default i18n;
