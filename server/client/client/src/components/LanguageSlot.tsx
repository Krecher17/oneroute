import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LanguageSwitcher } from './LanguageSwitcher';

const SLOTS = [
  { id: 'langSlot', variant: 'full' },           // setup: join with a code / create a trip
  { id: 'langSlotPlanner', variant: 'icon' },    // route planner
  { id: 'langSlotTop', variant: 'icon' },        // trip header: visible on every tab during a trip
] as const;

/** Puts the language picker on every screen after sign-in (the legacy markup provides the empty slots). */
export function LanguageSlot() {
  const [slots, setSlots] = useState<Array<{ el: HTMLElement; variant: 'full' | 'icon' }>>([]);
  useEffect(() => {
    setSlots(SLOTS.flatMap((s) => { const el = document.getElementById(s.id); return el ? [{ el, variant: s.variant }] : []; }));
  }, []);
  return <>{slots.map((s) => createPortal(<LanguageSwitcher variant={s.variant} />, s.el, s.el.id))}</>;
}
