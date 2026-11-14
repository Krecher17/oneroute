import { useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../../lib/api';

interface GoogleId {
  initialize(config: Record<string, unknown>): void;
  renderButton(el: HTMLElement, options: Record<string, unknown>): void;
}
declare global { interface Window { google?: { accounts?: { id?: GoogleId } } } }

let scriptPromise: Promise<void> | null = null;
function loadGoogleScript(): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('blocked')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * "Continue with Google". The Google script is only loaded on the sign-in screen, and only when the server
 * has a client ID. If it is missing or blocked, email sign-in simply keeps working.
 */
export function useGoogleSignIn(opts: {
  boxRef: RefObject<HTMLDivElement | null>;
  formRef: RefObject<HTMLFormElement | null>;
  mode: 'signin' | 'signup';
  onCredential: (credential: string) => void;
}): boolean {
  const [ready, setReady] = useState(false);
  const callback = useRef(opts.onCredential);
  callback.current = opts.onCredential;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api<{ googleClientId: string | null }>('/api/config');
        if (!cfg.googleClientId || cancelled) return;
        await loadGoogleScript();
        const id = window.google?.accounts?.id;
        if (!id || cancelled) return;
        id.initialize({
          client_id: cfg.googleClientId,
          callback: (resp: { credential?: string }) => { if (resp?.credential) callback.current(resp.credential); },
          auto_select: false,
          cancel_on_tap_outside: true,
        });
        setReady(true);
      } catch { /* offline or blocked */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const box = opts.boxRef.current;
    const id = window.google?.accounts?.id;
    if (!ready || !box || !id) return;
    box.replaceChildren();
    const width = Math.min(340, Math.max(200, Math.floor(opts.formRef.current?.getBoundingClientRect().width ?? 300)));
    id.renderButton(box, {
      type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill',
      text: opts.mode === 'signup' ? 'signup_with' : 'signin_with', logo_alignment: 'left', width,
    });
  }, [ready, opts.mode, opts.boxRef, opts.formRef]);

  return ready;
}
