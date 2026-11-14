import type { TFunction } from 'i18next';

/** A message the UI should translate (key + values), so it can change language after being shown. */
export class KeyedError extends Error {
  constructor(public key: string, public params: Record<string, unknown> = {}) { super(key); }
}
export class NetworkError extends Error {
  constructor() { super('network'); }
}
export class ApiError extends Error {
  constructor(public status: number, public code: string | undefined, message: string, public data: Record<string, unknown> = {}) { super(message); }
}

// Server codes that already have a client-side message of their own.
const CODE_TO_KEY: Record<string, string> = {
  terms_required: 'err.consent',
  name_required: 'err.name',
  email_invalid: 'err.email',
  password_short: 'err.passwordShort',
};

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; signal?: AbortSignal; rawBody?: Blob; contentType?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.rawBody) { body = opts.rawBody; headers['Content-Type'] = opts.contentType ?? 'application/octet-stream'; }
  else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }

  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? 'GET', headers, body, signal: opts.signal, cache: 'no-store' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError();
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, data.code as string | undefined, String(data.error ?? ''), data);
  return data as T;
}

export type Msg = { key: string; params?: Record<string, unknown> } | { raw: string };

/** Describes an error as a translation key where we have one, else the server's own text. */
export function toMsg(err: unknown, fallbackKey = 'err.generic'): Msg {
  if (err instanceof KeyedError) return { key: err.key, params: err.params };
  if (err instanceof NetworkError) return { key: 'err.network' };
  if (err instanceof ApiError) {
    if (err.code) return { key: CODE_TO_KEY[err.code] ?? `server.${err.code}` };
    return err.message ? { raw: err.message } : { key: fallbackKey };
  }
  return err instanceof Error && err.message ? { raw: err.message } : { key: fallbackKey };
}

/** Turns any error into text in the current language. */
export function errorText(err: unknown, t: TFunction, fallbackKey = 'err.generic'): string {
  const m = toMsg(err, fallbackKey);
  if ('raw' in m) return m.raw;
  // A server code we have no translation for falls back to the server's own wording.
  const text = t(m.key, { ...m.params, defaultValue: '' });
  return text || (err instanceof ApiError && err.message) || t(fallbackKey);
}
