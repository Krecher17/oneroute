// auth.js
// ONEROUTE accounts — backed by Supabase Auth + public.profiles table.
// All existing API routes (/api/signup, /api/login, /api/me, /api/logout,
// /api/avatar, /api/account/delete, /api/google, /api/config) are preserved.

import crypto from 'crypto';
import express from 'express';
import { supabase } from './supabase.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const TERMS_VERSION = '2026-10-25';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_AVATAR_BYTES = 120 * 1024;
const MAX_USERS = 5000;

const cleanEmail = (v) => String(v || '').trim().toLowerCase().slice(0, 254);

/** Shape sent to the browser — never include hash / salt */
function publicUser(supaUser, profile) {
  return {
    id:          supaUser.id,
    email:       supaUser.email,
    name:        profile?.name  || supaUser.user_metadata?.name || supaUser.email?.split('@')[0] || 'Driver',
    avatar:      profile?.avatar_url || null,
    hasPassword: !!(supaUser.user_metadata?.has_password),
  };
}

/** Load the profile row for a user id */
async function getProfile(userId) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
  return data || null;
}

/** Upsert a profile row (safe to call multiple times) */
async function upsertProfile(userId, fields) {
  const { error } = await supabase
    .from('profiles')
    .upsert({ id: userId, ...fields }, { onConflict: 'id' });
  if (error) throw error;
}

// ─── brute-force protection (in-memory, same as before) ─────────────────────

const attempts = new Map();
const ipHits   = new Map();
const WINDOW_MS   = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

const clientIp   = (req) => String(req.headers['cf-connecting-ip'] || req.ip || 'unknown');
const attemptKey = (req, email) => `${clientIp(req)}|${email}`;

function tooManyAttempts(key) {
  const now = Date.now();
  if (attempts.size > 5000) attempts.clear();
  const e = attempts.get(key);
  return e && now <= e.reset && e.n >= MAX_ATTEMPTS;
}
function recordFailure(key) {
  const now = Date.now();
  const e   = attempts.get(key);
  if (!e || now > e.reset) attempts.set(key, { n: 1, reset: now + WINDOW_MS });
  else e.n += 1;
}

export function ipLimiter(req, res, next) {
  const now = Date.now();
  if (ipHits.size > 5000) ipHits.clear();
  const ip  = clientIp(req);
  const hit = ipHits.get(ip) || { n: 0, reset: now + WINDOW_MS };
  if (now > hit.reset) { hit.n = 0; hit.reset = now + WINDOW_MS; }
  hit.n += 1;
  ipHits.set(ip, hit);
  if (hit.n > 40) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  next();
}

// ─── token resolution ────────────────────────────────────────────────────────

/**
 * Resolve a bearer token → public user object, or null.
 * Supabase JWTs are validated by the library internally.
 */
export async function authUserFromToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4000) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    const profile = await getProfile(data.user.id);
    return publicUser(data.user, profile);
  } catch {
    return null;
  }
}

const bearer = (req) => {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

export async function requireAuth(req, res, next) {
  const user = await authUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Please sign in first.' });
  req.user = user;
  next();
}

// ─── avatar helpers (now stored in Supabase Storage) ────────────────────────

const BUCKET = 'avatars';

async function ensureBucket() {
  const { data: list } = await supabase.storage.listBuckets();
  if (!list?.find((b) => b.name === BUCKET)) {
    await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX_AVATAR_BYTES });
  }
}
ensureBucket().catch((e) => console.warn('avatar bucket check failed:', e.message));

async function uploadAvatar(userId, jpegBuffer) {
  const path = `${userId}/${crypto.randomBytes(8).toString('hex')}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, jpegBuffer, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

async function removeAvatar(storagePath) {
  if (!storagePath) return;
  await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
}

// ─── Google sign-in (keep existing logic) ───────────────────────────────────

let CONFIG = { googleClientId: String(process.env.GOOGLE_CLIENT_ID || '').trim() };

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let certCache = { keys: null, until: 0 };

async function fetchGoogleCerts(force = false) {
  if (!force && certCache.keys && Date.now() < certCache.until) return certCache.keys;
  const response = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`certs ${response.status}`);
  const body = await response.json();
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers?.get?.('cache-control') || '')?.[1]) || 3600;
  certCache = { keys: body.keys || [], until: Date.now() + Math.min(maxAge, 86400) * 1000 };
  return certCache.keys;
}

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export async function verifyGoogleIdToken(idToken, clientId, getCerts = fetchGoogleCerts) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3 || idToken.length > 4000) throw new Error('malformed token');
  const header = b64json(parts[0]);
  const claims = b64json(parts[1]);
  if (header.alg !== 'RS256') throw new Error('bad algorithm');

  let jwk = (await getCerts(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getCerts(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');

  const key   = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!valid) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) throw new Error('bad issuer');
  if (!clientId || claims.aud !== clientId) throw new Error('wrong app');
  if (!(claims.exp > now)) throw new Error('expired');
  if (claims.iat && claims.iat > now + 300) throw new Error('issued in the future');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('email not verified');
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') throw new Error('missing details');
  return claims;
}

export function authStatus() {
  return `Accounts: stored in Supabase (${process.env.SUPABASE_URL}) | Google sign-in: ${CONFIG.googleClientId ? 'ON' : 'off'}`;
}

// ─── avatarForUser (used by index.js when someone joins a trip) ──────────────

export async function avatarForUser(userId) {
  const profile = await getProfile(userId);
  return profile?.avatar_url || null;
}

// ─── route registration ──────────────────────────────────────────────────────

export function registerAuthRoutes(app, hooks = {}) {

  // ── /api/config  (Google client ID) ──
  app.get('/api/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ googleClientId: CONFIG.googleClientId || null });
  });

  // ── /api/signup ──
  app.post('/api/signup', ipLimiter, async (req, res) => {
    try {
      const name     = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
      const email    = cleanEmail(req.body?.email);
      const password = String(req.body?.password || '');

      if (req.body?.acceptTerms !== true) return res.status(400).json({ error: 'Please tick the box to agree to the Terms and Privacy Policy.' });
      if (!name)                          return res.status(400).json({ error: 'Enter your name.' });
      if (!EMAIL_RE.test(email))          return res.status(400).json({ error: 'Enter a valid email address.' });
      if (password.length < 8)            return res.status(400).json({ error: 'Use a password with at least 8 characters.' });
      if (password.length > 128)          return res.status(400).json({ error: 'That password is too long (128 characters max).' });

      // Check user count
      const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
      if ((count || 0) >= MAX_USERS) return res.status(503).json({ error: 'Sign-ups are closed right now.' });

      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name, has_password: true },
      });

      if (error) {
        if (error.message?.toLowerCase().includes('already')) {
          return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
        }
        throw error;
      }

      await upsertProfile(data.user.id, {
        name,
        terms_version: TERMS_VERSION,
        terms_at:      new Date().toISOString(),
      });

      // Sign in to get a token
      const { data: signIn, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) throw signInErr;

      const profile = await getProfile(data.user.id);
      console.log('account created');
      res.status(201).json({ token: signIn.session.access_token, user: publicUser(data.user, profile) });
    } catch (err) {
      console.error('signup failed:', err);
      res.status(500).json({ error: 'Could not create the account. Try again.' });
    }
  });

  // ── /api/login ──
  app.post('/api/login', ipLimiter, async (req, res) => {
    try {
      const email    = cleanEmail(req.body?.email);
      const password = String(req.body?.password || '').slice(0, 128);
      const key      = attemptKey(req, email);

      if (tooManyAttempts(key)) return res.status(429).json({ error: 'Too many wrong attempts. Wait a few minutes and try again.' });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        recordFailure(key);
        return res.status(401).json({ error: 'Wrong email or password.' });
      }

      attempts.delete(key);
      const profile = await getProfile(data.user.id);
      res.json({ token: data.session.access_token, user: publicUser(data.user, profile) });
    } catch (err) {
      console.error('login failed:', err);
      res.status(500).json({ error: 'Could not sign in. Try again.' });
    }
  });

  // ── /api/me ──
  app.get('/api/me', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ user: req.user });
  });

  // ── /api/google ──
  app.post('/api/google', ipLimiter, async (req, res) => {
    try {
      if (!CONFIG.googleClientId) return res.status(404).json({ error: 'Google sign-in is not set up on this server.' });

      let claims;
      try {
        claims = await verifyGoogleIdToken(req.body?.credential, CONFIG.googleClientId);
      } catch (err) {
        console.log(`google sign-in refused: ${err.message}`);
        return res.status(401).json({ error: 'Google sign-in could not be verified. Try again.' });
      }

      const email = cleanEmail(claims.email);

      // Look up existing user by google_sub or email
      let { data: existingProfile } = await supabase
        .from('profiles')
        .select('id, google_sub')
        .or(`google_sub.eq.${claims.sub},id.eq.${email}`)
        .maybeSingle();

      // Also try finding by email in auth.users
      const { data: userList } = await supabase.auth.admin.listUsers();
      const existingAuthUser = userList?.users?.find((u) => u.email === email);

      if (!existingAuthUser) {
        // New user — require consent
        if (req.body?.acceptTerms !== true) {
          return res.status(409).json({ needConsent: true, name: String(claims.given_name || claims.name || '').slice(0, 20) });
        }

        const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
        if ((count || 0) >= MAX_USERS) return res.status(503).json({ error: 'Sign-ups are closed right now.' });

        const name = String(claims.name || claims.given_name || email.split('@')[0]).trim().replace(/\s+/g, ' ').slice(0, 20) || 'Driver';
        const { data, error } = await supabase.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: { name, google_sub: claims.sub, has_password: false },
        });
        if (error) throw error;

        await upsertProfile(data.user.id, {
          name,
          google_sub:    claims.sub,
          terms_version: TERMS_VERSION,
          terms_at:      new Date().toISOString(),
        });

        // Issue a session via admin (password-less Google user)
        const { data: session } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
        // Use admin token approach
        const { data: signInData } = await supabase.auth.admin.createSession({ userId: data.user.id });
        const profile = await getProfile(data.user.id);
        console.log('account created (google)');
        return res.status(201).json({ token: signInData.session.access_token, user: publicUser(data.user, profile) });
      }

      // Existing user — link google_sub if not yet linked
      const profile = await getProfile(existingAuthUser.id);
      if (!profile?.google_sub) {
        await upsertProfile(existingAuthUser.id, { google_sub: claims.sub });
      } else if (profile.google_sub !== claims.sub) {
        return res.status(401).json({ error: 'This email belongs to a different Google account.' });
      }

      const { data: signInData } = await supabase.auth.admin.createSession({ userId: existingAuthUser.id });
      const updatedProfile = await getProfile(existingAuthUser.id);
      console.log('google sign-in');
      res.json({ token: signInData.session.access_token, user: publicUser(existingAuthUser, updatedProfile) });
    } catch (err) {
      console.error('google sign-in failed:', err);
      res.status(500).json({ error: 'Could not sign in with Google. Try again.' });
    }
  });

  // ── /api/avatar  (PUT — upload) ──
  const rawJpeg = (req, res, next) =>
    express.raw({ type: 'image/jpeg', limit: MAX_AVATAR_BYTES })(req, res, (err) => {
      if (err) return res.status(413).json({ error: 'That photo is too large. Try a smaller one.' });
      next();
    });

  app.put('/api/avatar', requireAuth, ipLimiter, rawJpeg, async (req, res) => {
    try {
      const body   = req.body;
      const isJpeg = Buffer.isBuffer(body) && body.length > 200 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
      if (!isJpeg) return res.status(400).json({ error: 'Choose a JPEG, PNG or WebP photo.' });

      const profile = await getProfile(req.user.id);

      // Delete old avatar from storage
      if (profile?.avatar_path) await removeAvatar(profile.avatar_path);

      const { path: storagePath, url } = await uploadAvatar(req.user.id, body);
      await upsertProfile(req.user.id, { avatar_url: url, avatar_path: storagePath });

      const updatedUser = { ...req.user, avatar: url };
      res.json({ user: updatedUser });
    } catch (err) {
      console.error('avatar upload failed:', err);
      res.status(500).json({ error: 'Could not save your photo. Try again.' });
    }
  });

  app.delete('/api/avatar', requireAuth, async (req, res) => {
    try {
      const profile = await getProfile(req.user.id);
      if (profile?.avatar_path) await removeAvatar(profile.avatar_path);
      await upsertProfile(req.user.id, { avatar_url: null, avatar_path: null });
      res.json({ user: { ...req.user, avatar: null } });
    } catch (err) {
      console.error('avatar delete failed:', err);
      res.status(500).json({ error: 'Could not remove your photo. Try again.' });
    }
  });

  // Avatars are now public URLs from Supabase Storage — no /avatar/:file route needed.
  // Keep a stub so old cached links don't 500.
  app.get('/avatar/:file', (_req, res) => res.status(410).end());

  // ── /api/account/delete ──
  app.post('/api/account/delete', requireAuth, ipLimiter, async (req, res) => {
    try {
      const key = attemptKey(req, req.user.email);
      if (tooManyAttempts(key)) return res.status(429).json({ error: 'Too many wrong attempts. Wait a few minutes and try again.' });

      const typed    = String(req.body?.password || '').slice(0, 128);
      const hasPass  = req.user.hasPassword;

      if (hasPass) {
        // Verify current password
        const { error } = await supabase.auth.signInWithPassword({ email: req.user.email, password: typed });
        if (error) {
          recordFailure(key);
          return res.status(401).json({ error: 'That password is not right.' });
        }
      } else {
        // Google-only account: type DELETE
        if (typed !== 'DELETE') {
          recordFailure(key);
          return res.status(401).json({ error: 'Type DELETE to confirm.' });
        }
      }

      // Remove avatar
      const profile = await getProfile(req.user.id);
      if (profile?.avatar_path) await removeAvatar(profile.avatar_path);

      // Delete from Supabase Auth (cascades to profiles via FK)
      const { error: delErr } = await supabase.auth.admin.deleteUser(req.user.id);
      if (delErr) throw delErr;

      if (typeof hooks.onAccountDeleted === 'function') hooks.onAccountDeleted(req.user.id);
      console.log('account deleted');
      res.json({ ok: true });
    } catch (err) {
      console.error('delete account failed:', err);
      res.status(500).json({ error: 'Could not delete the account. Try again.' });
    }
  });

  // ── /api/logout ──
  app.post('/api/logout', async (req, res) => {
    try {
      const token = bearer(req);
      if (token) await supabase.auth.admin.signOut(token).catch(() => {});
    } catch { /* not critical */ }
    res.json({ ok: true });
  });
}
