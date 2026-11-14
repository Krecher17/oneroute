import { useTranslation } from 'react-i18next';
import { setTheme, useTheme } from '../lib/theme';

const Sun = () => (<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
const Moon = () => (<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>);

/** Light / dark switch. "icon" is a round button for headers; "full" shows the label too. */
export function ThemeToggle({ variant = 'full', className = '' }: { variant?: 'full' | 'icon'; className?: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const toLight = theme === 'dark';
  const label = toLight ? t('theme.toLight') : t('theme.toDark');
  return (
    <button type="button" className={`theme-toggle ${variant} ${className}`.trim()} aria-label={label} title={label}
      onClick={() => setTheme(toLight ? 'light' : 'dark')}>
      <span className="theme-toggle-symbol" key={theme}>{toLight ? <Sun /> : <Moon />}</span>
      {variant === 'full' && <span>{toLight ? t('theme.light') : t('theme.dark')}</span>}
    </button>
  );
}
