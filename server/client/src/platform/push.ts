import { registerPlugin } from '@capacitor/core';
import { api } from '../lib/api';
import { isNative, platformName } from './index';

interface PushPlugin {
  requestPermissions(): Promise<{ receive: 'granted' | 'denied' | 'prompt' }>;
  register(): Promise<void>;
  addListener(event: 'registration', cb: (token: { value: string }) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: 'registrationError', cb: (err: { error: string }) => void): Promise<{ remove(): Promise<void> }>;
}
const PushNotifications = registerPlugin<PushPlugin>('PushNotifications');

/**
 * Android/iOS app only. Asks permission, gets the device token and gives it to the server so convoy alerts
 * (SOS, missed turn) can reach people whose app is closed. A no-op in the browser.
 * Sending the notifications themselves is a server job (Firebase Cloud Messaging), see README.
 */
export async function registerForPush(authToken: string): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return false;
    await PushNotifications.addListener('registration', ({ value }) => {
      void api('/api/push/register', { method: 'POST', token: authToken, body: { token: value, platform: platformName() } }).catch(() => {});
    });
    await PushNotifications.addListener('registrationError', () => { /* offline or no Google services: ignore */ });
    await PushNotifications.register();
    return true;
  } catch {
    return false;
  }
}
