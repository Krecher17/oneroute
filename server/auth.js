// auth.js
// ONEROUTE accounts: sign up, log in, and stay logged in on a device.
// No extra packages needed: uses Node's built-in crypto and a small JSON file store.
//
// Files created automatically next to this one:
//   data/users.json     accounts (passwords are stored only as salted scrypt hashes)
//   data/sessions.json  saved logins (only a hash of each login token is stored)
//   data/avatars/       profile pictures, named by a random id (not the account id)
// Keep the data folder private. Do not share or upload it.

import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Set DATA_DIR to a folder on a disk that is kept between restarts (needed on hosts like Render or Railway).
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(HERE, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars'); // profile pictures (small JPEGs)
const MAX_AVATAR_BYTES = 120 * 1024;
const AVATAR_FILE_RE = /^[a-f0-9]{32}\.jpg$/;

const DAY = 24 * 60 * 60 * 1000;
const REMEMBER_MS = 365 * DAY; // "Keep me signed in" ticked; renewed every time the person uses the app
const SHORT_MS = 1 * DAY; // not ticked
const MAX_USERS = 5000;
const TERMS_VERSION = '2026-10-25'; // bump when the Terms or Privacy Policy change in a way people must re-accept

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// -------------------- Tiny file store --------------------
function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    try {
      const restored = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')); // file missing but a backup copy exists
      console.error(`WARNING: ${file} was missing, so the backup copy was used.`);
      return restored;
    } catch {
      return fallback; // first run: no file yet
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    // Never throw away accounts silently: keep the unreadable file as a backup and say so.
    const backup = `${file}.unreadable-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
    } catch {
      /* ignore */
    }
    console.error(`WARNING: ${file} could not be read. It was kept as ${backup}.`);
    try {
      const restored = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
      console.error('The last good backup copy was loaded instead.');
      return restored;
    } catch {
      return fallback;
    }
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = JSON.stringify(value);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  // A second copy of the latest saved version, used automatically if the main file ever goes missing or unreadable
  const backup = () => {
    try {
      fs.writeFileSync(`${file}.bak`, data, { mode: 0o600 });
    } catch {
      /* not critical */
    }
  };
  // Replacing a file can fail briefly on Windows (antivirus, OneDrive, indexing), so retry a few times.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file);
      backup();
      return;
    } catch (err) {
      if (attempt === 4) {
        try {
          fs.writeFileSync(file, data, { mode: 0o600 }); // last resort: write in place
          fs.rmSync(tmp, { force: true });
          backup();
          return;
        } catch {
          throw err;
        }
      }
      sleepSync(40 * (attempt + 1));
    }
  }
}

const users = new Map(); // email -> user
const sessions = new Map(); // tokenHash -> { userId, expiresAt }
const usersById = new Map();

for (const user of readJson(USERS_FILE, { users: [] }).users || []) {
  users.set(user.email, user);
  usersById.set(user.id, user);
}
{
  const now = Date.now();
  for (const s of readJson(SESSIONS_FILE, { sessions: [] }).sessions || []) {
    if (s.expiresAt > now && usersById.has(s.userId)) sessions.set(s.tokenHash, { userId: s.userId, expiresAt: s.expiresAt, long: !!s.long });
  }
}

const saveUsers = () => writeJson(USERS_FILE, { users: [...users.values()] });
const saveSessions = () =>
  writeJson(SESSIONS_FILE, {
    sessions: [...sessions.entries()].map(([tokenHash, s]) => ({ tokenHash, ...s })),
  });

// -------------------- Passwords and tokens --------------------
const scrypt = (password, salt) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return { salt: salt.toString('hex'), hash: key.toString('hex') };
}

async function passwordMatches(password, user) {
  // Unknown email: still do the same work so timing does not reveal which emails exist.
  const salt = Buffer.from(user && user.salt ? user.salt : '00'.repeat(16), 'hex');
  const key = await scrypt(password, salt);
  if (!user || !user.hash) return false; // unknown email, or an account that only uses Google
  const stored = Buffer.from(user.hash, 'hex');
  return stored.length === key.length && crypto.timingSafeEqual(stored, key);
}

function createSession(userId, remember) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(sha256(token), { userId, expiresAt: Date.now() + (remember ? REMEMBER_MS : SHORT_MS), long: !!remember });
  saveSessions();
  return token;
}

const avatarUrl = (user) => (user && user.avatarId ? `/avatar/${user.avatarId}.jpg` : null);
const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, avatar: avatarUrl(user), hasPassword: !!user.hash });

// Latest profile picture URL for an account (used when someone joins a trip).
export function avatarForUser(userId) {
  return avatarUrl(usersById.get(userId));
}

export function authUserFromToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const key = sha256(token);
  const session = sessions.get(key);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(key);
    saveSessions();
    return null;
  }
  const user = usersById.get(session.userId);
  if (user && session.long && Date.now() + REMEMBER_MS - session.expiresAt > DAY) {
    session.expiresAt = Date.now() + REMEMBER_MS; // sliding: people who keep using the app stay signed in
    try {
      saveSessions();
    } catch {
      /* not critical */
    }
  }
  return user ? publicUser(user) : null;
}

const bearer = (req) => {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

export function requireAuth(req, res, next) {
  const user = authUserFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Please sign in first.' });
  req.user = user;
  next();
}

// -------------------- Basic brute-force protection --------------------
const attempts = new Map(); // "ip|email" -> { n, reset }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.ip || 'unknown');
}

function attemptKey(req, email) {
  return `${clientIp(req)}|${email}`;
}

function tooManyAttempts(key) {
  const now = Date.now();
  if (attempts.size > 5000) attempts.clear();
  const entry = attempts.get(key);
  if (!entry || now > entry.reset) return false;
  return entry.n >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.reset) attempts.set(key, { n: 1, reset: now + WINDOW_MS });
  else entry.n += 1;
}

const ipHits = new Map();
function ipLimiter(req, res, next) {
  const now = Date.now();
  if (ipHits.size > 5000) ipHits.clear();
  const ip = clientIp(req);
  const hit = ipHits.get(ip) || { n: 0, reset: now + WINDOW_MS };
  if (now > hit.reset) {
    hit.n = 0;
    hit.reset = now + WINDOW_MS;
  }
  hit.n += 1;
  ipHits.set(ip, hit);
  if (hit.n > 40) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  next();
}


// -------------------- Google sign-in --------------------
// Needs a Google "OAuth client ID" (put it in config.json or the GOOGLE_CLIENT_ID setting). It is not a secret.
function readConfig() {
  const fromFile = readJson(path.join(HERE, 'config.json'), {});
  return { googleClientId: String(process.env.GOOGLE_CLIENT_ID || fromFile.googleClientId || '').trim() };
}
const CONFIG = readConfig();
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

// Checks Google's signature and the claims. Throws if anything is wrong.
export async function verifyGoogleIdToken(idToken, clientId, getCerts = fetchGoogleCerts) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3 || idToken.length > 4000) throw new Error('malformed token');
  const header = b64json(parts[0]);
  const claims = b64json(parts[1]);
  if (header.alg !== 'RS256') throw new Error('bad algorithm');

  let jwk = (await getCerts(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getCerts(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');

  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
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
  return `Accounts: ${users.size} saved in ${USERS_FILE} | Google sign-in: ${CONFIG.googleClientId ? 'ON' : 'off (add your client ID to config.json to turn it on)'}`;
}

export function registerGoogleRoutes(app, hooks = {}) {
  const getCerts = hooks.googleCerts || fetchGoogleCerts;

  // The page asks which sign-in options exist. The client ID is public by design.
  app.get('/api/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ googleClientId: CONFIG.googleClientId || null });
  });

  app.post('/api/google', ipLimiter, async (req, res) => {
    try {
      if (!CONFIG.googleClientId) return res.status(404).json({ error: 'Google sign-in is not set up on this server.' });

      let claims;
      try {
        claims = await verifyGoogleIdToken(req.body?.credential, CONFIG.googleClientId, getCerts);
      } catch (err) {
        console.log(`google sign-in refused: ${err.message}`);
        return res.status(401).json({ error: 'Google sign-in could not be verified. Try again.' });
      }

      const email = cleanEmail(claims.email);
      let user = [...usersById.values()].find((u) => u.googleSub === claims.sub) || users.get(email) || null;
      let created = false;

      if (!user) {
        if (req.body?.acceptTerms !== true) {
          return res.status(409).json({ needConsent: true, name: String(claims.given_name || claims.name || '').slice(0, 20) });
        }
        if (users.size >= MAX_USERS) return res.status(503).json({ error: 'Sign-ups are closed right now.' });
        const name = String(claims.name || claims.given_name || email.split('@')[0]).trim().replace(/\s+/g, ' ').slice(0, 20) || 'Driver';
        user = {
          id: crypto.randomUUID(), email, name, createdAt: Date.now(), googleSub: claims.sub,
          consent: { termsVersion: TERMS_VERSION, at: Date.now() },
        };
        users.set(email, user);
        usersById.set(user.id, user);
        created = true;
      } else if (!user.googleSub) {
        user.googleSub = claims.sub; // Google confirmed this email, so link it to the existing account
      } else if (user.googleSub !== claims.sub) {
        return res.status(401).json({ error: 'This email belongs to a different Google account.' });
      }

      try {
        saveUsers();
      } catch (err) {
        if (created) {
          users.delete(email);
          usersById.delete(user.id);
        }
        console.error('could not save accounts:', err.message);
        return res.status(500).json({ error: 'The server could not save your account (disk problem). Tell the person running it.' });
      }

      const token = createSession(user.id, req.body?.remember !== false);
      console.log(created ? 'account created (google)' : 'google sign-in');
      res.status(created ? 201 : 200).json({ token, user: publicUser(user) });
    } catch (error) {
      console.error('google sign-in failed:', error);
      res.status(500).json({ error: 'Could not sign in with Google. Try again.' });
    }
  });
}

// -------------------- Routes --------------------
const cleanEmail = (value) => String(value || '').trim().toLowerCase().slice(0, 254);

export function registerAuthRoutes(app, hooks = {}) {
  registerGoogleRoutes(app, hooks);
  app.post('/api/signup', ipLimiter, async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
      const email = cleanEmail(req.body?.email);
      const password = String(req.body?.password || '');

      if (req.body?.acceptTerms !== true) return res.status(400).json({ error: 'Please tick the box to agree to the Terms and Privacy Policy.' });
      if (!name) return res.status(400).json({ error: 'Enter your name.' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' });
      if (password.length > 128) return res.status(400).json({ error: 'That password is too long (128 characters max).' });
      if (users.has(email)) return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
      if (users.size >= MAX_USERS) return res.status(503).json({ error: 'Sign-ups are closed right now.' });

      const { salt, hash } = await hashPassword(password);
      if (users.has(email)) return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });

      const user = {
        id: crypto.randomUUID(), email, name, salt, hash, createdAt: Date.now(),
        consent: { termsVersion: TERMS_VERSION, at: Date.now() }, // proof of when the person agreed
      };
      users.set(email, user);
      usersById.set(user.id, user);
      try {
        saveUsers();
      } catch (err) {
        users.delete(email); // do not keep an account that could not be saved
        usersById.delete(user.id);
        console.error('could not save accounts:', err.message);
        return res.status(500).json({ error: 'The server could not save your account (disk problem). Tell the person running it.' });
      }

      const token = createSession(user.id, req.body?.remember !== false);
      console.log('account created');
      res.status(201).json({ token, user: publicUser(user) });
    } catch (error) {
      console.error('signup failed:', error);
      res.status(500).json({ error: 'Could not create the account. Try again.' });
    }
  });

  app.post('/api/login', ipLimiter, async (req, res) => {
    try {
      const email = cleanEmail(req.body?.email);
      const password = String(req.body?.password || '').slice(0, 128);
      const key = attemptKey(req, email);

      if (tooManyAttempts(key)) {
        return res.status(429).json({ error: 'Too many wrong attempts. Wait a few minutes and try again.' });
      }

      const user = users.get(email) || null;
      const ok = await passwordMatches(password, user);
      if (!ok) {
        recordFailure(key);
        return res.status(401).json({ error: 'Wrong email or password.' });
      }

      attempts.delete(key);
      const token = createSession(user.id, req.body?.remember !== false);
      res.json({ token, user: publicUser(user) });
    } catch (error) {
      console.error('login failed:', error);
      res.status(500).json({ error: 'Could not sign in. Try again.' });
    }
  });

  // Used by the page on every start to sign back in automatically.
  app.get('/api/me', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ user: req.user });
  });


  // ---------- Profile picture ----------
  // The page shrinks the photo to a small square JPEG before sending it.
  const rawJpeg = (req, res, next) =>
    express.raw({ type: 'image/jpeg', limit: MAX_AVATAR_BYTES })(req, res, (err) => {
      if (err) return res.status(413).json({ error: 'That photo is too large. Try a smaller one.' });
      next();
    });

  const removeAvatarFile = (avatarId) => {
    if (!avatarId) return;
    try {
      fs.unlinkSync(path.join(AVATAR_DIR, `${avatarId}.jpg`));
    } catch {
      /* already gone */
    }
  };

  app.put('/api/avatar', requireAuth, ipLimiter, rawJpeg, (req, res) => {
    try {
      const body = req.body;
      const isJpeg = Buffer.isBuffer(body) && body.length > 200 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
      if (!isJpeg) return res.status(400).json({ error: 'Choose a JPEG, PNG or WebP photo.' });

      const user = usersById.get(req.user.id);
      if (!user) return res.status(401).json({ error: 'Please sign in first.' });

      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      const avatarId = crypto.randomBytes(16).toString('hex');
      const file = path.join(AVATAR_DIR, `${avatarId}.jpg`);
      fs.writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);

      removeAvatarFile(user.avatarId);
      user.avatarId = avatarId; // a new id on every change, so browsers never show an old picture
      saveUsers();
      res.json({ user: publicUser(user) });
    } catch (error) {
      console.error('avatar upload failed:', error);
      res.status(500).json({ error: 'Could not save your photo. Try again.' });
    }
  });

  app.delete('/api/avatar', requireAuth, (req, res) => {
    const user = usersById.get(req.user.id);
    if (!user) return res.status(401).json({ error: 'Please sign in first.' });
    removeAvatarFile(user.avatarId);
    user.avatarId = null;
    saveUsers();
    res.json({ user: publicUser(user) });
  });

  // Pictures are fetched by <img> tags (which cannot send a login), so each one lives at a long random address.
  app.get('/avatar/:file', (req, res) => {
    const name = String(req.params.file || '');
    if (!AVATAR_FILE_RE.test(name)) return res.status(404).end();
    res.sendFile(
      path.join(AVATAR_DIR, name),
      {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      },
      (err) => {
        if (err && !res.headersSent) res.status(404).end();
      },
    );
  });


  // ---------- Delete my account (erases the account, photo and every saved login) ----------
  app.post('/api/account/delete', requireAuth, ipLimiter, async (req, res) => {
    try {
      const user = usersById.get(req.user.id);
      if (!user) return res.status(401).json({ error: 'Please sign in first.' });
      const key = attemptKey(req, user.email);
      if (tooManyAttempts(key)) return res.status(429).json({ error: 'Too many wrong attempts. Wait a few minutes and try again.' });

      const typed = String(req.body?.password || '').slice(0, 128);
      const ok = user.hash ? await passwordMatches(typed, user) : typed === 'DELETE'; // Google-only accounts type DELETE
      if (!ok) {
        recordFailure(key);
        return res.status(401).json({ error: user.hash ? 'That password is not right.' : 'Type DELETE to confirm.' });
      }

      removeAvatarFile(user.avatarId);
      users.delete(user.email);
      usersById.delete(user.id);
      for (const [tokenHash, s] of sessions) if (s.userId === user.id) sessions.delete(tokenHash);
      saveUsers();
      saveSessions();
      if (typeof hooks.onAccountDeleted === 'function') hooks.onAccountDeleted(user.id);
      console.log('account deleted');
      res.json({ ok: true });
    } catch (error) {
      console.error('delete account failed:', error);
      res.status(500).json({ error: 'Could not delete the account. Try again.' });
    }
  });

  app.post('/api/logout', (req, res) => {
    const token = bearer(req);
    if (token && sessions.delete(sha256(token))) saveSessions();
    res.json({ ok: true });
  });
}