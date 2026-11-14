import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const pages = [
  { title: 'Start or join a trip', actions: [
    ['Search', 'Find and select your destination.'],
    ['Create trip', 'Open the route planner and share the trip code with your convoy once the trip starts.'],
    ['Join trip', 'Enter the four-letter code shared by your convoy.'],
  ] },
  { title: 'Plan your route', actions: [
    ['Search for a waypoint', 'Find a fuel stop, rest area, or other place to add to your route.'],
    ['Confirm stops & start trip', 'Save your stops and open the convoy map.'],
  ] },
  { title: 'Navigate with your convoy', actions: [
    ['Navigation', 'Tap the teal button for turn-by-turn directions. Follow the yellow line. The section behind you turns gray.'],
    ['Recenter', 'Bring the map back to your location after moving it.'],
    ['Satellite', 'Switch between the street map and satellite imagery.'],
    ['Drop pin', 'Mark something on the map for your convoy.'],
  ] },
] as const;

export function TripTutorial({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = pages[step];
  const last = step === pages.length - 1;

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { heading.current?.focus(); }, [step]);

  return (
    <dialog ref={dialog} className="trip-tutorial" aria-labelledby="trip-tutorial-title"
      onCancel={(event) => { event.preventDefault(); onDone(); }}>
      <div className="trip-tutorial-header">
        <span>{t('tutorial.progress', { step: step + 1, total: pages.length, defaultValue: 'Step {{step}} of {{total}}' })}</span>
        <button type="button" className="trip-tutorial-quiet" onClick={onDone}>
          {t('tutorial.skip', 'Skip tutorial')}
        </button>
      </div>
      <div key={step} className="trip-tutorial-page">
        <h1 id="trip-tutorial-title" ref={heading} tabIndex={-1}>{t('tutorial.page' + step, page.title)}</h1>
        <dl>
          {page.actions.map(([label, description], index) => (
            <div key={label}>
              <dt><span className={label === 'Navigation' ? 'trip-tutorial-nav' : undefined}>{t('tutorial.label' + step + '_' + index, label)}</span></dt>
              <dd>{t('tutorial.description' + step + '_' + index, description)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="trip-tutorial-footer">
        {step > 0 && <button type="button" className="trip-tutorial-quiet" onClick={() => setStep(step - 1)}>{t('tutorial.back', 'Back')}</button>}
        <button type="button" className="trip-tutorial-next" onClick={last ? onDone : () => setStep(step + 1)}>
          {last ? t('tutorial.done', 'Finish tutorial') : t('tutorial.next', 'Next')}
        </button>
      </div>
    </dialog>
  );
}
