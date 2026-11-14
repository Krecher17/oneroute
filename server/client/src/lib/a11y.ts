export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const hasHover = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover)').matches;
