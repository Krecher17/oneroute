import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { etaSummary, type Eta } from '../../lib/eta';
import { useEngineState } from '../../lib/useEngineState';
import { useNow } from '../../lib/useNow';
import { useSlot } from '../../lib/useSlot';

/** "⏱ 2 h 15 min · 64 km · Arrive 4:45 pm": counts down as you get closer. */
export function EtaLine({ eta, className = '' }: { eta: Eta; className?: string }) {
  const { t } = useTranslation();
  const now = useNow();
  return (
    <span className={`eta-line ${className}`.trim()} title={t('eta.estimate')}>
      <span aria-hidden="true">⏱ </span>
      <span className="sr-only">{t('eta.toDestination')}: </span>
      {etaSummary(eta, now)}
    </span>
  );
}

/** The same line on the full-screen navigation map. */
export function NavEta() {
  const state = useEngineState();
  const slot = useSlot('etaSlotNav');
  const eta = state?.nav?.eta;
  if (!slot || !state?.inTrip || !eta) return null;
  return createPortal(<EtaLine eta={eta} className="nav-eta" />, slot);
}
