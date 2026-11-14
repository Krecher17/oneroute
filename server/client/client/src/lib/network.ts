import { config } from './config';

/**
 * In the website, `/api/...` already points at the right server. In the Android/iOS app the page is served
 * from the phone, so relative paths must be sent to the real server (VITE_SERVER_URL).
 */
export function installApiBase(): void {
  if (!config.serverUrl) return;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/') && !input.startsWith('//')) input = config.serverUrl + input;
    return original(input, init);
  }) as typeof window.fetch;
}
