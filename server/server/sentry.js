// sentry.js
// Optional error reporting for the server. Does nothing unless SENTRY_DSN is set in the environment,
// and the @sentry/node package is only loaded when it is. Names, positions and tokens are never sent.

let Sentry = null;

export async function initSentry() {
  const dsn = String(process.env.SENTRY_DSN || '').trim();
  if (!dsn) return false;
  try {
    Sentry = await import('@sentry/node');
  } catch {
    console.warn('SENTRY_DSN is set but @sentry/node is not installed. Run: npm install @sentry/node');
    return false;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.RELEASE || undefined,
    sendDefaultPii: false,
    beforeSend(event) {
      delete event.user;
      if (event.request) {
        delete event.request.headers;
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.query_string;
      }
      return event;
    },
  });
  console.log('Error reporting: Sentry is ON');
  return true;
}

/** Call after all routes are registered. */
export function attachSentry(app) {
  if (Sentry) Sentry.setupExpressErrorHandler(app);
}

/** For places that catch an error but still want it reported. */
export function reportError(error) {
  if (Sentry) Sentry.captureException(error);
}
