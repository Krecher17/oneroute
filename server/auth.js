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

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars'); // profile pictures (small JPEGs)
const MAX_AVATAR_BYTES = 120 * 1024;
const AVATAR_FILE_RE = /^[a-f0-9]{32}\.jpg$/;

const DAY = 24 * 60 * 60 * 1000;
const REMEMBER_MS = 90 * DAY; // "Keep me signed in" ticked
const SHORT_MS = 1 * DAY; // not ticked
const MAX_USERS = 5000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// -------------------- Tiny file store --------------------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic replace, so a crash never leaves half a file
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
    if (s.expiresAt > now && usersById.has(s.userId)) sessions.set(s.tokenHash, { userId: s.userId, expiresAt: s.expiresAt });
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
  const salt = Buffer.from(user ? user.salt : '00'.repeat(16), 'hex');
  const key = await scrypt(password, salt);
  if (!user) return false;
  const stored = Buffer.from(user.hash, 'hex');
  return stored.length === key.length && crypto.timingSafeEqual(stored, key);
}

function createSession(userId, remember) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(sha256(token), { userId, expiresAt: Date.now() + (remember ? REMEMBER_MS : SHORT_MS) });
  saveSessions();
  return token;
}

const avatarUrl = (user) => (user && user.avatarId ? `/avatar/${user.avatarId}.jpg` : null);
const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, avatar: avatarUrl(user) });

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

// -------------------- Routes --------------------
const cleanEmail = (value) => String(value || '').trim().toLowerCase().slice(0, 254);

export function registerAuthRoutes(app) {
  app.post('/api/signup', ipLimiter, async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
      const email = cleanEmail(req.body?.email);
      const password = String(req.body?.password || '');

      if (!name) return res.status(400).json({ error: 'Enter your name.' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (password.length < 8) return res.status(400).json({ error: 'Use a password with at least 8 characters.' });
      if (password.length > 128) return res.status(400).json({ error: 'That password is too long (128 characters max).' });
      if (users.has(email)) return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
      if (users.size >= MAX_USERS) return res.status(503).json({ error: 'Sign-ups are closed right now.' });

      const { salt, hash } = await hashPassword(password);
      if (users.has(email)) return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });

      const user = { id: crypto.randomUUID(), email, name, salt, hash, createdAt: Date.now() };
      users.set(email, user);
      usersById.set(user.id, user);
      saveUsers();

      const token = createSession(user.id, req.body?.remember !== false);
      console.log(`account created: ${email}`);
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

  app.post('/api/logout', (req, res) => {
    const token = bearer(req);
    if (token && sessions.delete(sha256(token))) saveSessions();
    res.json({ ok: true });
  });
}
