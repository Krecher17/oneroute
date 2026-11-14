import * as Sentry from '@sentry/react';
import { config } from './config';

const stripQuery = (url: unknown) => (typeof url === 'string' ? url.split('?')[0] : url);

/** Starts error reporting only when VITE_SENTRY_DSN is set. Locations, names and tokens are never sent. */
export function initSentry(): boolean {
  if (!config.sentryDsn) return false;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.environment,
    release: config.release,
    sendDefaultPii: false,
    // Errors only. No tracing and no session replay: this app handles live location.
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications.',
      /Non-Error promise rejection captured/,
      /User denied Geolocation/i,
      /NotAllowedError/,
      /AbortError/,
    ],
    beforeBreadcrumb(crumb) {
      if (crumb.data && 'url' in crumb.data) crumb.data.url = stripQuery(crumb.data.url);
      if (crumb.category === 'console') return null; // our logs can mention places and trip codes
      return crumb;
    },
    beforeSend(event) {
      delete event.user;
      if (event.request) {
        event.request.url = stripQuery(event.request.url) as string | undefined;
        delete event.request.headers;
        delete event.request.cookies;
        delete event.request.query_string;
      }
      return event;
    },
  });
  return true;
}

export { Sentry };
