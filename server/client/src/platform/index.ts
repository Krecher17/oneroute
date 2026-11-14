import { Capacitor } from '@capacitor/core';

/** True inside the Android/iOS app (Capacitor), false in a normal browser. */
export const isNative = (): boolean => Capacitor.isNativePlatform();
export const platformName = (): 'android' | 'ios' | 'web' => Capacitor.getPlatform() as 'android' | 'ios' | 'web';

/** True when the website has been installed to the home screen (PWA) or runs inside the app. */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return isNative() || !!nav.standalone || !!window.matchMedia?.('(display-mode: standalone)').matches;
}
