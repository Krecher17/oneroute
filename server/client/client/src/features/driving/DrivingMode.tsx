import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { bridge, type EngineState } from '../../lib/bridge';
import { useEngineState } from '../../lib/useEngineState';

const AUTO_KEY = 'oneroute-driving-auto';
const AUTO_SPEED_KMH = 20;
const AUTO_AFTER_MS = 8000;
const SOS_HOLD_MS = 1200;

const readAuto = (): boolean => { try { return localStorage.getItem(AUTO_KEY) === '1'; } catch { return false; } };
const buzz = (pattern: number | number[]) => { try { navigator.vibrate?.(pattern); } catch { /* unsupported */ } };

const WheelIcon = () => (<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.2" /><path d="M3.5 10.5 9.8 11.4M20.5 10.5l-6.3.9M12 14.2V21" /></svg>);
const HaltIcon = () => (<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>);
const MicIcon = () => (<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>);
const SoundIcon = ({ off }: { off: boolean }) => (<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" />{off ? <path d="m17 9 5 6M22 9l-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}</svg>);

type Tone = 'ok' | 'warn' | 'bad' | '';
function convoySummary(s: EngineState, t: (k: string, o?: Record<string, unknown>) => string): { text: string; tone: Tone } {
  if (!s.convoy.count) return { text: t('driving.waiting'), tone: '' };
  const issue = s.convoy.issues[0];
  if (!issue) return { text: t('driving.allOnRoute'), tone: 'ok' };
  if (issue.status === 'off') return { text: t('driving.off', { name: issue.name }), tone: 'bad' };
  if (issue.status === 'offline') return { text: t('driving.noSignal', { name: issue.name }), tone: 'warn' };
  return { text: t('driving.behind', { name: issue.name, km: issue.gapKm.toFixed(1) }), tone: 'warn' };
}

/** Press and hold so a pocket or a bump can never send an SOS. Tapping while an SOS is active cancels it. */
function SosButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const fill = useRef<HTMLSpanElement>(null);
  // Lifting a finger after a completed hold produces a click; that click must not undo the SOS we just sent.
  const justSent = useRef(false);

  const stop = () => {
    window.clearTimeout(timer.current);
    setHolding(false);
    if (fill.current) { fill.current.style.transition = 'none'; fill.current.style.width = '0'; }
  };
  const start = () => {
    if (active || holding) return;
    setHolding(true);
    buzz(30);
    if (fill.current) { fill.current.style.transition = `width ${SOS_HOLD_MS}ms linear`; fill.current.style.width = '100%'; }
    timer.current = window.setTimeout(() => {
      stop(); buzz([200, 80, 200]); justSent.current = true;
      window.setTimeout(() => { justSent.current = false; }, 800);
      onToggle();
    }, SOS_HOLD_MS);
  };
  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <button
      type="button" className="drv-btn drv-sos" aria-pressed={active}
      onClick={(e) => { if (e.detail === 0 || justSent.current) return; if (active) onToggle(); }} // detail 0 = keyboard, handled below
      onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); if (active) onToggle(); else start(); } }}
      onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') stop(); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="fill" ref={fill} aria-hidden="true" />
      <span>{t('driving.sos')}<small>{active ? t('driving.sosActive') : holding ? t('driving.sosHolding') : t('driving.sosHold')}</small></span>
    </button>
  );
}

function Overlay({ state, onExit, auto, setAuto }: { state: EngineState | undefined; onExit: () => void; auto: boolean; setAuto: (v: boolean) => void }) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const shownSos = useRef('');

  useEffect(() => {
    bridge.run('navData', true); // keeps turn-by-turn running even though the navigation screen is closed
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onExit(); };
    window.addEventListener('keydown', esc);
    return () => { bridge.run('navData', false); document.body.style.overflow = previous; window.removeEventListener('keydown', esc); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const helpNames = state?.incomingSos ?? [];
  useEffect(() => {
    const key = helpNames.join('|');
    if (key && key !== shownSos.current) buzz([500, 150, 500, 150, 500]);
    shownSos.current = key;
  }, [helpNames]);

  const speed = state?.speedKmh;
  const convoy = state ? convoySummary(state, t) : { text: t('driving.waiting'), tone: '' as Tone };
  const nav = state?.nav;

  return (
    <div className="drv" role="dialog" aria-modal="true" aria-label={t('driving.title')} tabIndex={-1} ref={root}>
      <div className="drv-top">
        <div className="drv-meta">
          <span className={`drv-dot${state?.gpsOk ? '' : ' wait'}`} aria-hidden="true" />
          <span>{state?.gpsOk ? (state.tripCode ? t('driving.tripLabel', { code: state.tripCode }) : t('driving.title')) : t('driving.gpsWaiting')}</span>
        </div>
        <button type="button" className="drv-exit" onClick={onExit}>{t('driving.exit')}</button>
      </div>

      {helpNames.length > 0 && <div className="drv-alert" role="alert">🆘 {t('driving.incomingSos', { name: helpNames[0] })}</div>}

      {nav ? (
        <div className="drv-turn">
          <div className="drv-turn-icon" aria-hidden="true">{nav.icon}</div>
          <div className="drv-turn-label">{t('driving.nextTurn')}</div>
          <div className="drv-turn-dist">{nav.distance}</div>
          <div className="drv-turn-text">{nav.text}{nav.road ? <span className="drv-turn-road"> · {nav.road}</span> : null}</div>
        </div>
      ) : (
        <div className="drv-turn idle"><div className="drv-turn-text">{t('driving.noRoute')}</div></div>
      )}

      <div className="drv-speed" aria-live="off">
        <b>{typeof speed === 'number' ? speed : '--'}</b><span>{t('driving.speedUnit')}</span>
      </div>

      <div className={`drv-convoy ${convoy.tone}`}>
        <span className="drv-convoy-state">{convoy.text}</span>
        {!!state?.convoy.count && <small>{t('driving.count', { count: state.convoy.count })}</small>}
      </div>

      <div className="drv-actions">
        <SosButton active={!!state?.sos} onToggle={() => bridge.run('sos')} />
        <button type="button" className="drv-btn" aria-pressed={!!state?.halted} onClick={() => bridge.run('halt')}>
          <HaltIcon /><span>{t('driving.halt')}{state?.halted && <small>{t('driving.haltActive')}</small>}</span>
        </button>
        <button type="button" className="drv-btn rec" aria-pressed={!!state?.recording} onClick={() => bridge.run('voice')}>
          <MicIcon /><span>{t('driving.voice')}{state?.recording && <small>{t('driving.voiceRecording')}</small>}</span>
        </button>
        <button type="button" className="drv-btn" aria-pressed={!state?.navVoice} onClick={() => bridge.run('navVoice', !state?.navVoice)}>
          <SoundIcon off={!state?.navVoice} /><span>{state?.navVoice ? t('driving.mute') : t('driving.unmute')}</span>
        </button>
      </div>

      <div className="drv-foot">
        <label>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>{t('driving.auto')}<em>{t('driving.autoHint', { speed: AUTO_SPEED_KMH })}</em></span>
        </label>
      </div>
      <p className="drv-tip">{t('driving.tip')}</p>
    </div>
  );
}

/** Entry button (map screen, during a trip) + the full-screen driving overlay. Can switch itself on above 20 km/h. */
export function DrivingMode() {
  const { t } = useTranslation();
  const state = useEngineState();
  // The button lives inside the map screen (next to its heading), so it only shows on that tab and never covers anything.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById('drivingSlot')); }, []);
  const [active, setActive] = useState(false);
  const [auto, setAutoState] = useState(readAuto);
  const optedOut = useRef(false);   // the person closed it by hand during this trip: don't switch it on again
  const fastSince = useRef(0);
  const latest = useRef(state);
  latest.current = state;

  const setAuto = (v: boolean) => { setAutoState(v); try { localStorage.setItem(AUTO_KEY, v ? '1' : '0'); } catch { /* private mode */ } };
  const exit = () => { optedOut.current = true; setActive(false); };

  // New trip, or the trip ended: start fresh
  useEffect(() => { if (!state?.inTrip) { optedOut.current = false; fastSince.current = 0; setActive(false); } }, [state?.inTrip]);

  // Automatic switch-on: only after 8 seconds above 20 km/h, never after the person has closed it themselves
  useEffect(() => {
    if (!auto || active) return;
    const id = window.setInterval(() => {
      const s = latest.current;
      if (!s?.inTrip || optedOut.current || (s.speedKmh ?? 0) < AUTO_SPEED_KMH) { fastSince.current = 0; return; }
      fastSince.current ||= Date.now();
      if (Date.now() - fastSince.current >= AUTO_AFTER_MS) { setActive(true); buzz(60); }
    }, 1000);
    return () => window.clearInterval(id);
  }, [auto, active]);

  const showEntry = !!state?.inTrip && !active && !!slot;
  return (
    <>
      {showEntry && createPortal(
        <button type="button" className="drv-entry" onClick={() => { optedOut.current = false; setActive(true); }}>
          <WheelIcon /><span>{t('driving.title')}</span>
        </button>,
        slot!,
      )}
      {active && <Overlay state={state} onExit={exit} auto={auto} setAuto={setAuto} />}
    </>
  );
}
