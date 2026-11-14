import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { bridge } from '../../lib/bridge';
import { useSlot } from '../../lib/useSlot';
import { useEngineState } from '../../lib/useEngineState';
import { EtaLine } from './EtaLine';

/**
 * The next turn, right on the live map: distance, instruction and road, in the person's language.
 * It follows the trip from the start (a preview until GPS is found, then live), and opens full-screen navigation when tapped.
 */
export function TurnCard() {
  const { t } = useTranslation();
  const state = useEngineState();
  const slot = useSlot('turnSlot');
  if (!slot || !state?.inTrip) return null;
  const nav = state.nav;

  return createPortal(
    <button type="button" className={`turn-card${nav ? '' : ' idle'}`} onClick={() => bridge.run('openNavigation')} aria-label={t('turn.open')}>
      {nav ? (
        <>
          <span className="turn-card-icon" aria-hidden="true">{nav.icon}</span>
          <span className="turn-card-main">
            <span className="turn-card-dist">{nav.distance}</span>
            <span className="turn-card-text turn-instruction-enter" key={JSON.stringify([nav.icon, nav.text, nav.road])}>{nav.text}{nav.road ? <span className="turn-card-road"> · {nav.road}</span> : null}</span>
            {nav.eta && <EtaLine eta={nav.eta} className="turn-card-eta" />}
            {nav.preview && <span className="turn-card-note">{t('turn.preview')}</span>}
          </span>
        </>
      ) : (
        <span className="turn-card-text">{state.gpsOk ? t('turn.preparing') : t('driving.gpsWaiting')}</span>
      )}
    </button>,
    slot,
  );
}
