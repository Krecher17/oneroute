import { useSyncExternalStore } from 'react';
import { bridge, type EngineState } from './bridge';

/** Live trip state published by the engine (speed, convoy, SOS, navigation...). Undefined until the first update. */
export function useEngineState(): EngineState | undefined {
  return useSyncExternalStore(
    (notify) => bridge.on('state', notify),
    () => bridge.last<EngineState>('state'),
  );
}

/** Which bottom-tab screen is showing ('map', 'status', 'chat', 'summary'). */
export function useScreen(): string | undefined {
  return useSyncExternalStore(
    (notify) => bridge.on('screen', notify),
    () => bridge.last<string>('screen'),
  );
}
