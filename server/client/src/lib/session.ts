export const AUTH_KEY = 'oneroute-token';

/** The saved login token (kept in localStorage when "keep me signed in" was ticked, else sessionStorage). */
export function readToken(): string {
  try { return localStorage.getItem(AUTH_KEY) || sessionStorage.getItem(AUTH_KEY) || ''; } catch { return ''; }
}

/** Trip code from an invite link such as /?code=AB12, or '' if there is none. */
export function getInviteCode(search: string = window.location.search): string {
  const raw = new URLSearchParams(search).get('code');
  const code = raw ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : '';
  return code.length === 4 ? code : '';
}

export interface AccountUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string | null;
  hasPassword?: boolean;
}
