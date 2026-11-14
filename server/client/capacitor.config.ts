import type { CapacitorConfig } from '@capacitor/cli';

// Used later, when you build the Android app (see README, "Android app").
// Change appId to your own reverse-domain id before publishing; it cannot be changed after release.
const config: CapacitorConfig = {
  appId: 'app.oneroute.convoy',
  appName: 'ONEROUTE',
  webDir: '../web-dist',
  server: { androidScheme: 'https' },
  android: { allowMixedContent: false },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
