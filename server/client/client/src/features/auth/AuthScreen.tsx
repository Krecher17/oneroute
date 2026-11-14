import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, ApiError, errorText, toMsg, type Msg } from '../../lib/api';
import { squareJpeg, uploadAvatarWith } from '../../lib/avatar';
import { bridge } from '../../lib/bridge';
import { hasHover, prefersReducedMotion } from '../../lib/a11y';
import { getInviteCode, readToken, type AccountUser } from '../../lib/session';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { useGoogleSignIn } from './useGoogleSignIn';

type Mode = 'signin' | 'signup';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const legalLink = { target: '_blank', rel: 'noopener noreferrer' } as const;

interface AuthResponse { token: string; user: AccountUser }

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const { t } = useTranslation();
  const invite = useMemo(() => getInviteCode(), []);

  const [mode, setMode] = useState<Mode>('signin');
  const [booting, setBooting] = useState<boolean>(() => !!readToken());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Msg | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [consent, setConsent] = useState(false);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [pendingGoogle, setPendingGoogle] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const googleBox = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const up = mode === 'signup';
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : ''), [photo]);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  const fail = (key: string, params?: Record<string, unknown>) => setError({ key, params });
  const failWith = (err: unknown) => setError(toMsg(err));
  const message = error ? ('key' in error ? t(error.key, error.params) : error.raw) : '';

  // ---- Stay signed in: if this device has a saved login, skip the form -------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      const token = readToken();
      if (!token) return;
      await bridge.ready;
      try {
        const { user } = await api<{ user: AccountUser }>('/api/me', { token, signal: AbortSignal.timeout?.(8000) });
        if (!alive) return;
        bridge.run('enterApp', user);
        onSignedIn();
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiError) { bridge.run('clearToken'); fail('err.sessionEnded'); }
        else fail('err.serverSlow');
        setBooting(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Finishing sign-in (shared by password and Google) ---------------------------------------------
  async function finish(data: AuthResponse, keep: boolean, signupPhoto: Blob | null) {
    await bridge.ready;
    bridge.run('storeToken', data.token, keep);
    let user = data.user;
    let photoNote = '';
    if (signupPhoto) {
      try { user = (await uploadAvatarWith(signupPhoto, data.token)) as unknown as AccountUser; }
      catch (err) { photoNote = t('err.photoSave', { reason: errorText(err, t) }); }
    }
    bridge.run('enterApp', user);
    if (photoNote) bridge.run('photoMessage', photoNote);
    onSignedIn();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const nameValue = name.trim();
    const mail = email.trim();
    if (up && !nameValue) return fail('err.name');
    if (!EMAIL_RE.test(mail)) return fail('err.email');
    if (!password) return fail('err.passwordEmpty');
    if (up && password.length < 8) return fail('err.passwordShort');
    if (up && !consent) { fail('err.consent'); consentRef.current?.focus(); return; }
    setError(null);
    setBusy(true);
    try {
      const data = await api<AuthResponse>(up ? '/api/signup' : '/api/login', {
        method: 'POST',
        body: { name: nameValue, email: mail, password, remember, acceptTerms: up ? consent : undefined },
      });
      setPassword('');
      await finish(data, remember, up ? photo : null);
    } catch (err) {
      failWith(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendGoogle(credential: string, acceptTerms: boolean) {
    setBusy(true);
    setError(null);
    try {
      const data = await api<AuthResponse>('/api/google', {
        method: 'POST',
        body: { credential, acceptTerms: acceptTerms || undefined, remember },
      });
      setPendingGoogle(null);
      await finish(data, remember, null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data.needConsent) {
        setPendingGoogle(credential);
        const given = typeof err.data.name === 'string' && err.data.name ? `, ${err.data.name}` : '';
        fail('err.googleConsent', { name: given });
        consentRef.current?.focus();
      } else failWith(err);
    } finally {
      setBusy(false);
    }
  }

  const googleReady = useGoogleSignIn({
    boxRef: googleBox,
    formRef,
    mode,
    onCredential: (credential) => void sendGoogle(credential, false),
  });

  function switchMode() {
    setMode(up ? 'signin' : 'signup');
    setError(null);
    setPendingGoogle(null);
  }

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    try { setPhoto(await squareJpeg(file)); setError(null); } catch (err) { failWith(err); }
  }

  // Focus the first field on devices with a mouse (on phones it would pop the keyboard open uninvited).
  useEffect(() => {
    if (booting || !hasHover()) return;
    const id = window.setTimeout(() => (up ? nameRef.current : emailRef.current)?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [mode, booting, up]);

  // Subtle 3D tilt on the card (mouse devices only, off for reduced motion)
  useEffect(() => {
    const stage = stageRef.current;
    const tilt = tiltRef.current;
    if (!stage || !tilt || prefersReducedMotion() || !hasHover()) return;
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const move = (e: MouseEvent) => {
      const r = stage.getBoundingClientRect();
      tilt.style.setProperty('--ry', `${clamp((e.clientX - r.left - r.width / 2) / 300) * 10}deg`);
      tilt.style.setProperty('--rx', `${-clamp((e.clientY - r.top - r.height / 2) / 300) * 10}deg`);
    };
    const leave = () => { tilt.style.setProperty('--rx', '0deg'); tilt.style.setProperty('--ry', '0deg'); };
    stage.addEventListener('mousemove', move);
    stage.addEventListener('mouseleave', leave);
    return () => { stage.removeEventListener('mousemove', move); stage.removeEventListener('mouseleave', leave); };
  }, []);

  const showConsent = up || pendingGoogle !== null;

  return (
    <section id="auth" aria-label={t('auth.titleSignin')}>
      <div className="auth-noise" />
      <div className="auth-glow auth-glow-top" />
      <div className="auth-glow auth-glow-bottom" />
      <div className="auth-stage" id="authStage" ref={stageRef}>
        <div className="auth-tilt" id="authTilt" ref={tiltRef}>
          <div className="auth-beams" aria-hidden="true">
            <i className="beam b-top" /><i className="beam b-right" /><i className="beam b-bottom" /><i className="beam b-left" />
          </div>
          <div className="auth-card" aria-busy={booting || busy}>
            <div className="auth-head">
              <div className="auth-logo" aria-hidden="true">⬡</div>
              <h1 id="authTitle">{booting ? t('auth.signingIn') : up ? t('auth.titleSignup') : t('auth.titleSignin')}</h1>
              {!booting && <p id="authSub">{up ? t('auth.subSignup') : t('auth.subSignin')}</p>}
              {invite && <p id="authInvite" className="auth-invite" role="status">{t('auth.invite', { code: invite })}</p>}
            </div>

            {!booting && (
              <>
                <form id="authForm" ref={formRef} noValidate onSubmit={submit}>
                  {up && (
                    <div id="authAvatarField">
                      <button type="button" className={`auth-avatar${photo ? ' has-photo' : ''}`} id="authAvatarBtn" onClick={() => fileRef.current?.click()}>
                        <span className="auth-avatar-ring">
                          {!photo && (
                            <svg id="authAvatarIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" /><circle cx="12" cy="13" r="3.5" /></svg>
                          )}
                          {photo && <img id="authAvatarPreview" src={photoUrl} alt="" />}
                        </span>
                        <span id="authAvatarLabel">{photo ? t('auth.photoChange') : t('auth.photoAdd')}</span>
                      </button>
                      {photo && <button type="button" className="auth-avatar-clear" id="authAvatarClear" onClick={() => setPhoto(null)}>{t('auth.photoRemove')}</button>}
                      <input type="file" id="authAvatarFile" ref={fileRef} accept="image/*" hidden
                        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void pickPhoto(f); }} />
                    </div>
                  )}

                  {up && (
                    <div className="auth-field" id="authNameField">
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                      <label className="sr-only" htmlFor="authName">{t('auth.name')}</label>
                      <input className="auth-input" id="authName" name="name" type="text" maxLength={20} autoComplete="name"
                        placeholder={t('auth.name')} ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                  )}

                  <div className="auth-field">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></svg>
                    <label className="sr-only" htmlFor="authEmail">{t('auth.email')}</label>
                    <input className="auth-input" id="authEmail" name="email" type="email" inputMode="email" autoComplete="username"
                      autoCapitalize="none" spellCheck={false} placeholder={t('auth.email')} ref={emailRef}
                      value={email} onChange={(e) => setEmail(e.target.value)} />
                  </div>

                  <div className="auth-field">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                    <label className="sr-only" htmlFor="authPassword">{t('auth.password')}</label>
                    <input className="auth-input" id="authPassword" name="password" type={showPw ? 'text' : 'password'}
                      autoComplete={up ? 'new-password' : 'current-password'}
                      placeholder={up ? t('auth.passwordNew') : t('auth.password')}
                      value={password} onChange={(e) => setPassword(e.target.value)} />
                    <button type="button" className="auth-eye" id="authEye" aria-pressed={showPw}
                      aria-label={showPw ? t('auth.hidePassword') : t('auth.showPassword')} onClick={() => setShowPw((v) => !v)}>
                      {!showPw && <svg id="eyeOn" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" /></svg>}
                      {showPw && <svg id="eyeOff" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" /><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" /><path d="m2 2 20 20" /></svg>}
                    </button>
                  </div>

                  <label className="auth-remember">
                    <input type="checkbox" id="authRemember" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> {t('auth.remember')}
                  </label>

                  {showConsent && (
                    <div className="auth-consent" id="authConsentRow">
                      <label>
                        <input type="checkbox" id="authConsent" ref={consentRef} checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                        <span>
                          <Trans i18nKey="auth.consent" components={{
                            terms: <a href="/terms.html" {...legalLink} />,
                            privacy: <a href="/privacy.html" {...legalLink} />,
                          }} />
                        </span>
                      </label>
                    </div>
                  )}

                  <div id="authError" role="alert">{message}</div>

                  <button className={`auth-submit${busy ? ' loading' : ''}`} id="authSubmit" type="submit" disabled={busy}>
                    <span className="auth-submit-label" id="authSubmitLabel">{up ? t('auth.submitSignup') : t('auth.submitSignin')}</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
                    <span className="auth-spin" aria-hidden="true" />
                  </button>
                </form>

                <div className="auth-or" id="authOr" hidden={!googleReady}><span>{t('auth.or')}</span></div>
                <div className="auth-google" id="authGoogle" ref={googleBox} hidden={!googleReady} />
                {pendingGoogle && (
                  <button type="button" className="auth-google-continue" id="authGoogleContinue" disabled={busy}
                    onClick={() => { if (!consent) { fail('err.consent'); consentRef.current?.focus(); return; } void sendGoogle(pendingGoogle, true); }}>
                    {t('auth.googleAgree')}
                  </button>
                )}

                <p className="auth-switch">
                  <span id="authSwitchText">{up ? t('auth.haveAccount') : t('auth.noAccount')}</span>{' '}
                  <button type="button" className="auth-link" id="authSwitch" onClick={switchMode}>{up ? t('auth.toSignin') : t('auth.toSignup')}</button>
                </p>
                <p className="auth-note">{t('auth.note')}</p>
              </>
            )}

            {booting && <p className="auth-note" role="status">{t('auth.signingIn')}</p>}

            <LanguageSwitcher className="auth-lang" />

            <footer className="legal-footer auth-legal" aria-label={t('legal.aria')}>
              <a href="/privacy.html" {...legalLink}>{t('legal.privacy')}</a> ·{' '}
              <a href="/terms.html" {...legalLink}>{t('legal.terms')}</a> ·{' '}
              <a href="/cookies.html" {...legalLink}>{t('legal.cookies')}</a> ·{' '}
              <a href="/refund.html" {...legalLink}>{t('legal.refund')}</a>
            </footer>
          </div>
        </div>
      </div>
    </section>
  );
}
