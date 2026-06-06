// Authentication: env-configured single user, signed session cookie, per-IP lockout.
// No external session store — the cookie is an HMAC-signed, expiring token.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const COOKIE = 'rsess';
const SESSION_TTL_MS = (Number(process.env.SESSION_DAYS) || 30) * 24 * 3600 * 1000;
const LOCK_THRESHOLD = Number(process.env.LOCKOUT_ATTEMPTS) || 5;
const LOCK_MS = (Number(process.env.LOCKOUT_MINUTES) || 15) * 60 * 1000;

const USER = process.env.AUTH_USER || 'admin';
const PASS = process.env.AUTH_PASS || '';

// Auth is active only when a password is configured. Otherwise the app is open
// (handy for a trusted LAN), and we warn loudly at boot.
export const authEnabled = PASS.length > 0;

// Persistent secret so sessions survive restarts.
function loadSecret() {
  const file = path.join(DATA_DIR, 'session.secret');
  try { return fs.readFileSync(file, 'utf8'); } catch { /* generate below */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, secret, { mode: 0o600 }); } catch { /* ephemeral */ }
  return secret;
}
const SECRET = loadSecret();

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');

function makeToken() {
  const payload = String(Date.now() + SESSION_TTL_MS);
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const isAuthedCookieHeader = (cookieHeader) =>
  !authEnabled || verifyToken(parseCookies(cookieHeader)[COOKIE]);

// --- per-IP lockout -------------------------------------------------------

const attempts = new Map(); // ip -> { fails, lockedUntil }
const stateFor = (ip) => {
  let s = attempts.get(ip);
  if (!s) { s = { fails: 0, lockedUntil: 0 }; attempts.set(ip, s); }
  return s;
};

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  // Compare a fixed-length digest to avoid leaking length via timing.
  const da = crypto.createHash('sha256').update(ba).digest();
  const db = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(da, db);
}

function cookieOpts(req) {
  return { httpOnly: true, sameSite: 'lax', secure: !!req.secure, maxAge: SESSION_TTL_MS, path: '/' };
}

// --- express handlers -----------------------------------------------------

export function loginHandler(req, res) {
  const ip = req.ip;
  const s = stateFor(ip);
  if (s.lockedUntil > Date.now()) {
    const mins = Math.ceil((s.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many attempts. Try again in ~${mins} min.` });
  }
  const { username = '', password = '' } = req.body || {};
  const ok = safeEqual(username, USER) && safeEqual(password, PASS);
  if (!ok) {
    s.fails += 1;
    if (s.fails >= LOCK_THRESHOLD) {
      s.lockedUntil = Date.now() + LOCK_MS;
      s.fails = 0;
      return res.status(429).json({ error: `Locked out for ~${LOCK_MS / 60000} min (too many attempts).` });
    }
    return res.status(401).json({ error: 'Invalid username or password', attemptsLeft: LOCK_THRESHOLD - s.fails });
  }
  s.fails = 0; s.lockedUntil = 0;
  res.cookie(COOKIE, makeToken(), cookieOpts(req));
  return res.json({ ok: true });
}

export function logoutHandler(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  return res.json({ ok: true });
}

// Gate for HTTP routes. Public paths (login page + login endpoint) are wired
// before this in index.js.
export function requireAuth(req, res, next) {
  if (!authEnabled) return next();
  if (verifyToken(parseCookies(req.headers.cookie)[COOKIE])) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}
