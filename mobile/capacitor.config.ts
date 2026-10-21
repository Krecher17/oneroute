import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.oneroute.app',
  appName: 'ONEROUTE',
  webDir: 'web',
  server: {
    url: 'https://oneroute.dpdns.org/index.html',
    cleartext: false,
    allowNavigation: ['oneroute.dpdns.org']
  },
  android: {
    allowMixedContent: false
  }
};

export default config;
