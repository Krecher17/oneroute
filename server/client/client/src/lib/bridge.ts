// A tiny typed event bus + command registry. The legacy engine publishes live state here and React
// screens (driving mode, banners...) subscribe, so React never has to reach into the engine's DOM.
type Handler<T = unknown> = (value: T) => void;

export interface NavPayload { icon: string; text: string; road: string; distance: string; arrive: boolean }
export interface ConvoyIssue { name: string; status: string; gapKm: number }

/** Live state the engine publishes once a second (only when something changed). */
export interface EngineState {
  inTrip: boolean;
  tripCode: string | null;
  speedKmh: number | null;
  gpsOk: boolean;
  halted: boolean;
  sos: boolean;
  navVoice: boolean;
  recording: boolean;
  connected: boolean;
  nav: NavPayload | null;
  convoy: { count: number; myStatus: string | null; issues: ConvoyIssue[] };
  incomingSos: string[];
}

class Bridge {
  private handlers = new Map<string, Set<Handler>>();
  private state = new Map<string, unknown>();
  /** Actions React can ask the engine to perform (registered by the engine at start-up). */
  commands: Record<string, (...args: unknown[]) => unknown> = {};

  private resolveReady!: () => void;
  /** Resolves once the engine has registered its commands. Await it before calling `run`. */
  ready: Promise<void> = new Promise<void>((resolve) => { this.resolveReady = resolve; });
  markReady(): void { this.resolveReady(); }

  on<T>(event: string, handler: Handler<T>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  emit<T>(event: string, value: T): void {
    this.state.set(event, value);
    this.handlers.get(event)?.forEach((h) => {
      try { h(value); } catch (err) { console.error(`bridge handler for "${event}" failed`, err); }
    });
  }

  /** Last value published for an event (lets late subscribers catch up). */
  last<T>(event: string): T | undefined {
    return this.state.get(event) as T | undefined;
  }

  run(command: string, ...args: unknown[]): unknown {
    const fn = this.commands[command];
    if (!fn) { console.warn(`bridge: no command "${command}"`); return undefined; }
    return fn(...args);
  }
}

export const bridge = new Bridge();
