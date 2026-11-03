// auth.js
// ONEROUTE accounts, stored locally on the server (no external database).
// Accounts and sessions live in data/accounts.json, avatars in data/avatars/.
// All routes are unchanged: /api/signup, /api/login, /api/me, /api/logout,
// /api/avatar, /api/account/delete, /api/google, /api/config, /avatar/:file

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const scrypt = promisify(crypto.scrypt);

// ─── helpers ────────────────────────────────────────────────────────────────

const TERMS_VERSION = '2026-10-25';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_AVATAR_BYTES = 120 * 1024;
const MAX_USERS = 5000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // stay signed in for 30 days

const cleanEmail = (v) => String(v || '').trim().toLowerCase().slice(0, 254);

// ─── storage (JSON file, written atomically) ────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(HERE, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');

let db = { users: {}, sessions: {} };

function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    db = { users: parsed.users || {}, sessions: parsed.sessions || {} };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('accounts file could not be read, starting empty:', err.message);
  }
  pruneSessions();
}

function saveDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${ACCOUNTS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, ACCOUNTS_FILE);
  } catch (err) {
    console.error('could not save accounts:', err.message);
    throw err;
  }
}

function pruneSessions() {
  const now = Date.now();
  for (const [k, s] of Object.entries(db.sessions)) if (!(s.exp > now)) delete db.sessions[k];
}

loadDb();

const userCount = () => Object.keys(db.users).length;
const findByEmail = (email) => Object.values(db.users).find((u) => u.email === email) || null;
const findByGoogleSub = (sub) => Object.values(db.users).find((u) => u.googleSub && u.googleSub === sub) || null;
const avatarUrl = (user) => (user?.avatarFile ? `/avatar/${user.avatarFile}` : null);

/** Shape sent to the browser, never includes the password hash */
function publicUser(user) {
  return {
    id:          user.id,
    email:       user.email,
    name:        user.name || user.email?.split('@')[0] || 'Driver',
    avatar:      avatarUrl(user),
    hasPassword: !!user.passwordHash,
  };
}

// ─── passwords and sessions ─────────────────────────────────────────────────

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

async function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY_HASH).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = await scrypt(password, Buffer.from(parts[1], 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected) && !!stored;
}

const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('hex');

function createSession(userId) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[tokenKey(token)] = { userId, exp: Date.now() + SESSION_MS };
  saveDb();
  return token;
}

function dropSessionsOf(userId) {
  for (const [k, s] of Object.entries(db.sessions)) if (s.userId === userId) delete db.sessions[k];
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

/** Resolve a bearer token → public user object, or null. */
export async function authUserFromToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4000) return null;
  const session = db.sessions[tokenKey(token)];
  if (!session || !(session.exp > Date.now())) return null;
  const user = db.users[session.userId];
  return user ? publicUser(user) : null;
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

// ─── avatar helpers (files in data/avatars) ─────────────────────────────────

function saveAvatarFile(jpegBuffer) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const file = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(AVATAR_DIR, file), jpegBuffer);
  return file;
}

function removeAvatarFile(file) {
  if (!file || !/^[a-f0-9]{32}\.jpg$/.test(file)) return;
  try { fs.unlinkSync(path.join(AVATAR_DIR, file)); } catch { /* already gone */ }
}

// ─── Google sign-in ─────────────────────────────────────────────────────────

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
  return `Accounts: stored locally (${ACCOUNTS_FILE}) | Google sign-in: ${CONFIG.googleClientId ? 'ON' : 'off'}`;
}

// ─── avatarForUser (used by index.js when someone joins a trip) ──────────────
// Synchronous on purpose: index.js uses the result directly.

export function avatarForUser(userId) {
  return avatarUrl(db.users[userId]);
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

      if (userCount() >= MAX_USERS) return res.status(503).json({ error: 'Sign-ups are closed right now.' });
      if (findByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });

      const passwordHash = await hashPassword(password);
      if (findByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });

      const user = {
        id:           crypto.randomUUID(),
        email,
        name,
        passwordHash,
        googleSub:    null,
        avatarFile:   null,
        termsVersion: TERMS_VERSION,
        termsAt:      new Date().toISOString(),
        createdAt:    new Date().toISOString(),
      };
      db.users[user.id] = user;
      const token = createSession(user.id);

      console.log('account created');
      res.status(201).json({ token, user: publicUser(user) });
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

      const user = findByEmail(email);
      const ok = await verifyPassword(password, user?.passwordHash); // runs a dummy check when there is no such user
      if (!user || !ok) {
        recordFailure(key);
        return res.status(401).json({ error: 'Wrong email or password.' });
      }

      attempts.delete(key);
      res.json({ token: createSession(user.id), user: publicUser(user) });
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

      const email    = cleanEmail(claims.email);
      const existing = findByGoogleSub(claims.sub) || findByEmail(email);

      if (!existing) {
        // New user: consent is required first
        if (req.body?.acceptTerms !== true) {
          return res.status(409).json({ needConsent: true, name: String(claims.given_name || claims.name || '').slice(0, 20) });
        }
        if (userCount() >= MAX_USERS) return res.status(503).json({ error: 'Sign-ups are closed right now.' });

        const name = String(claims.name || claims.given_name || email.split('@')[0]).trim().replace(/\s+/g, ' ').slice(0, 20) || 'Driver';
        const user = {
          id:           crypto.randomUUID(),
          email,
          name,
          passwordHash: null,
          googleSub:    claims.sub,
          avatarFile:   null,
          termsVersion: TERMS_VERSION,
          termsAt:      new Date().toISOString(),
          createdAt:    new Date().toISOString(),
        };
        db.users[user.id] = user;
        const token = createSession(user.id);
        console.log('account created (google)');
        return res.status(201).json({ token, user: publicUser(user) });
      }

      // Existing user: link the Google account if it is not linked yet
      if (!existing.googleSub) {
        existing.googleSub = claims.sub;
      } else if (existing.googleSub !== claims.sub) {
        return res.status(401).json({ error: 'This email belongs to a different Google account.' });
      }

      const token = createSession(existing.id); // also saves the link above
      console.log('google sign-in');
      res.json({ token, user: publicUser(existing) });
    } catch (err) {
      console.error('google sign-in failed:', err);
      res.status(500).json({ error: 'Could not sign in with Google. Try again.' });
    }
  });

  // ── /api/avatar  (PUT: upload) ──
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

      const user = db.users[req.user.id];
      if (!user) return res.status(401).json({ error: 'Please sign in first.' });

      const newFile = saveAvatarFile(body);
      const oldFile = user.avatarFile;
      user.avatarFile = newFile;
      saveDb();
      removeAvatarFile(oldFile);

      res.json({ user: { ...req.user, avatar: avatarUrl(user) } });
    } catch (err) {
      console.error('avatar upload failed:', err);
      res.status(500).json({ error: 'Could not save your photo. Try again.' });
    }
  });

  app.delete('/api/avatar', requireAuth, async (req, res) => {
    try {
      const user = db.users[req.user.id];
      if (user) {
        const oldFile = user.avatarFile;
        user.avatarFile = null;
        saveDb();
        removeAvatarFile(oldFile);
      }
      res.json({ user: { ...req.user, avatar: null } });
    } catch (err) {
      console.error('avatar delete failed:', err);
      res.status(500).json({ error: 'Could not remove your photo. Try again.' });
    }
  });

  // ── /avatar/:file  (serves saved profile pictures) ──
  app.get('/avatar/:file', (req, res) => {
    if (!/^[a-f0-9]{32}\.jpg$/.test(req.params.file)) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(req.params.file, { root: AVATAR_DIR, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // ── /api/account/delete ──
  app.post('/api/account/delete', requireAuth, ipLimiter, async (req, res) => {
    try {
      const key = attemptKey(req, req.user.email);
      if (tooManyAttempts(key)) return res.status(429).json({ error: 'Too many wrong attempts. Wait a few minutes and try again.' });

      const user  = db.users[req.user.id];
      const typed = String(req.body?.password || '').slice(0, 128);
      if (!user) return res.status(401).json({ error: 'Please sign in first.' });

      if (user.passwordHash) {
        if (!(await verifyPassword(typed, user.passwordHash))) {
          recordFailure(key);
          return res.status(401).json({ error: 'That password is not right.' });
        }
      } else if (typed !== 'DELETE') {
        // Google-only account: type DELETE
        recordFailure(key);
        return res.status(401).json({ error: 'Type DELETE to confirm.' });
      }

      removeAvatarFile(user.avatarFile);
      dropSessionsOf(user.id);
      delete db.users[user.id];
      saveDb();

      if (typeof hooks.onAccountDeleted === 'function') hooks.onAccountDeleted(req.user.id);
      console.log('account deleted');
      res.json({ ok: true });
    } catch (err) {
      console.error('delete account failed:', err);
      res.status(500).json({ error: 'Could not delete the account. Try again.' });
    }
  });

  // ── /api/logout ──
  app.post('/api/logout', (req, res) => {
    try {
      const token = bearer(req);
      if (token && db.sessions[tokenKey(token)]) {
        delete db.sessions[tokenKey(token)];
        saveDb();
      }
    } catch { /* not critical */ }
    res.json({ ok: true });
  });
}
