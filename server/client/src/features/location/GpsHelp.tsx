import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { bridge } from '../../lib/bridge';
import { useSlot } from '../../lib/useSlot';
import { useEngineState } from '../../lib/useEngineState';

type Permission = 'granted' | 'denied' | 'prompt' | 'unknown';
const SHOW_AFTER_SECONDS = 12;

/**
 * Shown when a trip is running but no location has arrived for a while. It says WHY (blocked, waiting for the
 * permission prompt, or the device not sharing a location) and offers the two ways out: try again, or place yourself on the map.
 */
export function GpsHelp() {
  const { t } = useTranslation();
  const state = useEngineState();
  const slot = useSlot('gpsHelpSlot');
  const [waited, setWaited] = useState(0);
  const [permission, setPermission] = useState<Permission>('unknown');

  const waiting = !!state?.inTrip && !state.gpsOk;
  useEffect(() => {
    if (!waiting) { setWaited(0); return; }
    const id = window.setInterval(() => setWaited((w) => w + 1), 1000);
    return () => window.clearInterval(id);
  }, [waiting]);

  useEffect(() => {
    if (waited < SHOW_AFTER_SECONDS - 1) return;
    let alive = true;
    navigator.permissions?.query({ name: 'geolocation' as PermissionName })
      .then((r) => { if (alive) setPermission(r.state as Permission); })
      .catch(() => { /* not supported: fall back to the generic message */ });
    return () => { alive = false; };
  }, [waited >= SHOW_AFTER_SECONDS - 1]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!slot || !waiting || waited < SHOW_AFTER_SECONDS) return null;

  const reason = !window.isSecureContext ? 'insecure'
    : permission === 'denied' || state?.gpsError === 1 ? 'denied'
    : permission === 'prompt' ? 'prompt'
    : 'unavailable';

  return createPortal(
    <div className="gps-help" role="alert">
      <p>{t(`gps.help.${reason}`)}</p>
      <div className="gps-help-actions">
        <button type="button" className="quiet" onClick={() => { setWaited(0); bridge.run('retryGps'); }}>{t('gps.retry')}</button>
        <button type="button" onClick={() => bridge.run('manualLocation')}>{t('gps.manual')}</button>
      </div>
    </div>,
    slot,
  );
}
