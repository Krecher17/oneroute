import { useEffect, useState } from 'react';
import { Sentry } from './lib/sentry';
import { LegacyApp } from './legacy/LegacyApp';
import { AuthScreen } from './features/auth/AuthScreen';
import { PwaPrompts } from './features/pwa/PwaPrompts';
import { DrivingMode } from './features/driving/DrivingMode';
import { LanguageSlot } from './components/LanguageSlot';
import { bridge } from './lib/bridge';
import { readToken } from './lib/session';
import { registerForPush } from './platform/push';
import { isNative } from './platform';

export function App() {
  const [signedIn, setSignedIn] = useState(false);

  // In the Android/iOS app: ask for notification permission once the person is signed in.
  useEffect(() => {
    if (!signedIn || !isNative()) return;
    void bridge.ready.then(() => registerForPush(String(bridge.run('getToken') || readToken())));
  }, [signedIn]);

  return (
    <Sentry.ErrorBoundary fallback={<p style={{ padding: 24 }}>Something went wrong. Please reload the page.</p>}>
      {!signedIn && <AuthScreen onSignedIn={() => setSignedIn(true)} />}
      <LegacyApp />
      <LanguageSlot />
      <DrivingMode />
      <PwaPrompts />
    </Sentry.ErrorBoundary>
  );
}
