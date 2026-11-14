import { useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useTranslation } from 'react-i18next';
import { useEngineState } from '../../lib/useEngineState';
import { isNative, isStandalone } from '../../platform';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'oneroute-install-dismissed';
const DISMISS_DAYS = 14;
const recentlyDismissed = (): boolean => {
  try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < DISMISS_DAYS * 864e5; } catch { return false; }
};
const isIosSafari = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent);

/**
 * Three small messages, none of which interrupt a drive:
 *  - "Install ONEROUTE" (once, dismissible for 2 weeks)
 *  - "A new version is ready": a person taps Update. The page never reloads by itself.
 *  - "You're offline" / "Reconnecting…"
 */
export function PwaPrompts() {
  const { t } = useTranslation();
  const state = useEngineState();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [installable, setInstallable] = useState(false);
  const [showIosHint, setShowIosHint] = useState(false);
  const deferred = useRef<InstallPromptEvent | null>(null);
  const registrationRef = useRef<ServiceWorkerRegistration | undefined>(undefined);

  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Look for a new version hourly while the app stays open.
      registrationRef.current = registration;
    },
  });

  useEffect(() => {
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void registrationRef.current?.update().catch(() => {});
      }
    };
    const interval = window.setInterval(checkForUpdate, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('online', checkForUpdate);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', checkForUpdate);
      window.removeEventListener('online', checkForUpdate);
    };
  }, []);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  useEffect(() => {
    if (isStandalone() || isNative() || recentlyDismissed()) return;
    const onPrompt = (e: Event) => { e.preventDefault(); deferred.current = e as InstallPromptEvent; setInstallable(true); };
    const onInstalled = () => { setInstallable(false); setShowIosHint(false); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    // Safari has no install event; show the manual hint after a short pause.
    const id = isIosSafari() ? window.setTimeout(() => setShowIosHint(true), 5000) : 0;
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      if (id) window.clearTimeout(id);
    };
  }, []);

  const dismissInstall = () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
    setInstallable(false);
    setShowIosHint(false);
  };
  const install = async () => {
    const ev = deferred.current;
    if (!ev) return;
    await ev.prompt();
    await ev.userChoice.catch(() => undefined);
    deferred.current = null;
    setInstallable(false);
  };

  const inTrip = !!state?.inTrip;
  const movingFast = inTrip && (state?.speedKmh ?? 0) > 10;
  const showUpdate = needRefresh && !movingFast;
  const showInstall = (installable || showIosHint) && !inTrip;
  const reconnecting = online && inTrip && state?.connected === false;

  if (online && !showUpdate && !showInstall && !reconnecting) return null;

  return (
    <div className={`prompt-stack${inTrip ? ' above-nav' : ''}`}>
      {!online && (
        <div className="conn-banner" role="status"><i aria-hidden="true" />{t('pwa.offline.title')}: {t('pwa.offline.body')}</div>
      )}
      {reconnecting && <div className="conn-banner" role="status"><i aria-hidden="true" />{t('pwa.reconnecting')}</div>}

      {showUpdate && (
        <div className="prompt" role="alertdialog" aria-labelledby="upd-t" aria-describedby="upd-b">
          <h2 id="upd-t">{t('pwa.update.title')}</h2>
          <p id="upd-b">{t('pwa.update.body')}</p>
          <div className="prompt-actions">
            <button type="button" className="quiet" onClick={() => setNeedRefresh(false)}>{t('pwa.update.later')}</button>
            <button type="button" onClick={() => void updateServiceWorker(true)}>{t('pwa.update.action')}</button>
          </div>
        </div>
      )}

      {showInstall && !showUpdate && (
        <div className="prompt" role="dialog" aria-labelledby="ins-t" aria-describedby="ins-b">
          <h2 id="ins-t">{t('pwa.install.title')}</h2>
          <p id="ins-b">{installable ? t('pwa.install.body') : t('pwa.install.iosHint')}</p>
          <div className="prompt-actions">
            <button type="button" className="quiet" onClick={dismissInstall}>{t('pwa.install.later')}</button>
            {installable && <button type="button" onClick={() => void install()}>{t('pwa.install.action')}</button>}
          </div>
        </div>
      )}
    </div>
  );
}
