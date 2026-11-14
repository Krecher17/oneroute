import { useEffect, useState } from 'react';

/** Finds an empty container that the legacy markup provides (React renders into it with a portal). */
export function useSlot(id: string): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById(id)); }, [id]);
  return slot;
}
