import { useTranslation } from 'react-i18next';
import { LANGUAGES, setLanguage, type LanguageCode } from '../i18n';

/** Compact language picker. Each language is shown in its own script so people can always find theirs. */
export function LanguageSwitcher({ className = '', variant = 'full' }: { className?: string; variant?: 'full' | 'icon' }) {
  const { t, i18n } = useTranslation();
  const current = (i18n.language ?? 'en').split('-')[0];
  return (
    <label className={`lang-switch${variant === 'icon' ? ' icon' : ''} ${className}`.trim()}>
      <span className="sr-only">{t('lang.label')}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
      <select value={current} onChange={(e) => void setLanguage(e.target.value as LanguageCode)} lang={current}>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>
        ))}
      </select>
    </label>
  );
}
