import { useEffect, useState } from 'react';

/** The current time, refreshed every `intervalMs`, so a clock time derived from it stays right while you are stopped. */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
