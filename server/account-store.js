import 'dotenv/config';

const url = process.env.SUPABASE_URL?.trim();
const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY)?.trim();
if (Boolean(url) !== Boolean(key)) throw new Error('Set both Supabase account storage credentials.');

export const usesSupabase = Boolean(url);
let endpoint;
if (url) {
  endpoint = new URL('/rest/v1/oneroute_account_store', url);
  if (endpoint.protocol !== 'https:') throw new Error('Supabase account storage requires HTTPS.');
}

let revision = 0;
let writes = Promise.resolve();

async function request(query, options = {}) {
  const response = await fetch(String(endpoint) + query, {
    ...options,
    headers: {
      apikey: key,
      ...(key.startsWith('sb_secret_') ? {} : { Authorization: 'Bearer ' + key }),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Supabase account storage request failed (HTTP ' + response.status + ').');
  return response.json();
}

export async function loadAccountStore(readLegacyFile) {
  const [existing] = await request('?id=eq.1&select=revision,snapshot');
  if (existing) {
    revision = existing.revision;
    return existing.snapshot;
  }

  const snapshot = readLegacyFile();
  if (!snapshot && process.env.ONEROUTE_ALLOW_EMPTY_ACCOUNT_STORE !== 'true') {
    throw new Error('No account backup found for the first Supabase import.');
  }
  const initial = snapshot ?? { users: {}, sessions: {} };
  await request('', { method: 'POST', body: JSON.stringify({ id: 1, snapshot: initial }) });
  return initial;
}

export function saveAccountStore(snapshot) {
  const copy = structuredClone(snapshot);
  writes = writes.then(async () => {
    const next = revision + 1;
    const updated = await request('?id=eq.1&revision=eq.' + revision, {
      method: 'PATCH',
      body: JSON.stringify({ revision: next, snapshot: copy }),
    });
    if (updated.length !== 1) throw new Error('Account store changed in another process.');
    revision = next;
  });
  // Stop serving potentially unsaved account state after a failed or ambiguous write.
  return writes.catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
