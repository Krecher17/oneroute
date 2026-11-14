import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api, toMsg, type Msg } from '../../lib/api';
import { bridge } from '../../lib/bridge';
import { useSlot } from '../../lib/useSlot';

interface Place { lat: number; lon: number; label: string; approx?: boolean }

/**
 * "Starting point" on the create-trip card. Left empty, the trip starts from where the person is now.
 * A chosen place is handed to the engine (setStart), which sends it instead of the GPS position, so no location is needed at all.
 */
export function StartPoint() {
  const { t } = useTranslation();
  const slot = useSlot('startSlot');
  const [text, setText] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [chosen, setChosen] = useState<Place | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The engine asks, when "Create trip" is pressed, whether something was typed but never picked.
  const live = useRef({ text, chosen });
  live.current = { text, chosen };
  const searchRef = useRef<() => void>(() => undefined);

  async function search() {
    const q = text.trim();
    if (!q) { setMsg(null); setResults([]); return; }
    setBusy(true); setChosen(null); bridge.run('setStart', null); setMsg(null);
    try {
      const token = String(bridge.run('getToken') || '');
      const list = await api<Place[]>(`/geocode?q=${encodeURIComponent(q)}`, { token });
      setResults(Array.isArray(list) ? list : []);
      setMsg(Array.isArray(list) && list.length ? null : { key: 'start.none' });
    } catch (err) {
      setResults([]); setMsg(toMsg(err, 'start.failed'));
    } finally { setBusy(false); }
  }
  searchRef.current = () => { void search(); };

  useEffect(() => {
    bridge.commands.startStatus = () => ({ typed: live.current.text.trim(), chosen: !!live.current.chosen });
    bridge.commands.searchStart = () => { inputRef.current?.focus(); searchRef.current(); };
    return () => { delete bridge.commands.startStatus; delete bridge.commands.searchStart; };
  }, []);

  function choose(place: Place) {
    setChosen(place); setResults([]); setText(place.label); setMsg(null);
    bridge.run('setStart', { lat: place.lat, lon: place.lon, label: place.label });
  }
  function useCurrent() {
    setChosen(null); setResults([]); setText(''); setMsg(null);
    bridge.run('setStart', null);
    inputRef.current?.focus();
  }
  function edit(value: string) {
    setText(value);
    if (chosen) { setChosen(null); bridge.run('setStart', null); } // editing the text drops the earlier choice
  }

  if (!slot) return null;
  return createPortal(
    <div className="start-field">
      <label className="field-label" htmlFor="startPlace">{t('start.label')}</label>
      <div className="search-row">
        <input id="startPlace" ref={inputRef} value={text} autoComplete="off" placeholder={t('start.placeholder')}
          onChange={(e) => edit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }} />
        <button type="button" id="startSearch" aria-label={t('start.searchAria')} disabled={busy} onClick={() => void search()}>
          {busy ? t('start.searching') : t('start.search')}
        </button>
      </div>
      {results.length > 0 && (
        <div className="results" id="startResults">
          {results.some((p) => p.approx) && <div className="dym">{t('search.didYouMean')}</div>}
          {results.map((p) => <button type="button" key={`${p.lat},${p.lon},${p.label}`} onClick={() => choose(p)}>{p.label}</button>)}
        </div>
      )}
      {chosen ? (
        <p className="chosen-dest" role="status">
          {t('start.chosen', { place: chosen.label })}{' '}
          <button type="button" className="link-button" onClick={useCurrent}>{t('start.useCurrent')}</button>
        </p>
      ) : !msg && <p className="field-hint">{t('start.hint')}</p>}
      {msg && <p className="field-error" role="alert">{'key' in msg ? t(msg.key, msg.params) : msg.raw}</p>}
    </div>,
    slot,
  );
}
