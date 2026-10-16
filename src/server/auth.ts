import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { ENV_AUTH_ENABLED, ENV_AUTH_PASSWORD, ENV_AUTH_USERNAME } from './config.js';
import { getSetting, setSetting } from './db.js';
import { ApiError, ah } from './http.js';
import { getSecret } from './secrets.js';
import type { AuthStatus } from '../shared/types.js';

const COOKIE_NAME = 'spinseek_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

/** 'none' means no login exists yet: the app is locked until the first account is created. */
export type AuthSource = 'env' | 'settings' | 'none';

export function authSource(): AuthSource {
  if (ENV_AUTH_ENABLED) return 'env';
  if (getSetting('auth_username') && getSetting('auth_password_hash')) return 'settings';
  return 'none';
}

/** Constant-time comparison for any secret (hashing first equalizes lengths). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = (stored || DUMMY_HASH).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return safeEqual(candidate, hash);
}

function currentUsername(): string {
  const source = authSource();
  if (source === 'env') return ENV_AUTH_USERNAME;
  if (source === 'settings') return getSetting('auth_username');
  return '';
}

/** Both checks always run (no short-circuit), so timing doesn't reveal whether the username exists. */
function verifyCredentials(username: string, password: string): boolean {
  const source = authSource();
  if (source === 'env') {
    const userOk = safeEqual(username, ENV_AUTH_USERNAME);
    const passOk = safeEqual(password, ENV_AUTH_PASSWORD);
    return userOk && passOk;
  }
  if (source === 'settings') {
    const userOk = safeEqual(username, getSetting('auth_username'));
    const passOk = verifyPassword(password, getSetting('auth_password_hash'));
    return userOk && passOk;
  }
  return false;
}

/** Re-authentication for sensitive actions (revealing/regenerating secrets, changing the login). */
export function verifyCurrentPassword(password: unknown): boolean {
  if (typeof password !== 'string' || !password) return false;
  const source = authSource();
  if (source === 'env') return safeEqual(password, ENV_AUTH_PASSWORD);
  if (source === 'settings') return verifyPassword(password, getSetting('auth_password_hash'));
  return false;
}

/** Changes whenever credentials change, invalidating previously issued sessions. */
function credentialVersion(): string {
  const material =
    authSource() === 'env' ? `env:${ENV_AUTH_USERNAME}:${ENV_AUTH_PASSWORD}` : `db:${getSetting('auth_username')}:${getSetting('auth_password_hash')}`;
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 12);
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', getSecret('session_secret')).update(payload).digest('base64url');
}

function createSessionToken(username: string): string {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_MAX_AGE_MS, v: credentialVersion() })).toString(
    'base64url',
  );
  return `${payload}.${sign(payload)}`;
}

function readSession(token: string | undefined): { username: string } | null {
  if (!token || authSource() === 'none') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u: string; exp: number; v: string };
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    if (data.v !== credentialVersion() || data.u !== currentUsername()) return null;
    return { username: data.u };
  } catch {
    return null;
  }
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Secure flag when served over HTTPS, directly or via a TLS-terminating reverse proxy. Trusting the
 * forwarded-proto header here is harmless: it can only make the cookie stricter.
 */
function isHttps(req: Request): boolean {
  return req.secure || (req.get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase() === 'https';
}

function setSessionCookie(req: Request, res: Response, username: string): void {
  res.cookie(COOKIE_NAME, createSessionToken(username), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(req),
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

function hasValidApiKey(req: Request): boolean {
  const provided = (req.header('x-api-key') || (typeof req.query.apikey === 'string' ? req.query.apikey : '')).trim();
  const expected = getSecret('api_key');
  return provided.length > 0 && expected.length > 0 && safeEqual(provided, expected);
}

function sessionFor(req: Request): { username: string } | null {
  return readSession(getCookie(req, COOKIE_NAME));
}

function validateNewCredentials(username: unknown, password: unknown): { user: string; pass: string } {
  const user = typeof username === 'string' ? username.trim() : '';
  if (!user || user.length > 64) throw new ApiError(400, 'Username is required (max 64 characters).');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 256) throw new ApiError(400, 'Password is too long.');
  if (password.toLowerCase() === user.toLowerCase()) throw new ApiError(400, 'Password must not be the same as the username.');
  return { user, pass: password };
}

/**
 * The only routes reachable without a session (exact method + path; anything else is denied).
 * /health carries no data and is used by the Docker healthcheck; logout only clears the caller's cookie;
 * the Lidarr webhook authenticates with its own secret.
 */
const PUBLIC_ROUTES = new Set(['GET /health', 'GET /auth/status', 'POST /auth/login', 'POST /auth/logout', 'POST /webhook/lidarr']);

/**
 * Default-deny guard, mounted on /api before every route handler. Requires a valid session cookie or
 * X-Api-Key. Client IP / X-Forwarded-For never grants access.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const route = `${req.method} ${req.path}`;
  if (PUBLIC_ROUTES.has(route)) return next();
  if (route === 'POST /auth/setup') {
    // First boot only: once any login exists, setup is gone for good.
    if (authSource() === 'none') return next();
    res.status(403).json({ error: 'Setup has already been completed.' });
    return;
  }
  if (hasValidApiKey(req)) return next();
  if (authSource() === 'none') {
    res.status(401).json({ error: 'Create a login to finish setting up Spin Seek.', setupRequired: true });
    return;
  }
  if (sessionFor(req)) return next();
  res.status(401).json({ error: 'Authentication required' });
}

// In-memory brute-force guard (login, setup, re-authentication). Keyed on req.ip, which is the
// socket address unless TRUST_PROXY is explicitly configured.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export function checkRate(req: Request): void {
  const entry = attempts.get(req.ip ?? 'unknown');
  if (entry && entry.resetAt > Date.now() && entry.count >= MAX_FAILURES) {
    throw new ApiError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }
}

export function recordFailure(req: Request): void {
  const ip = req.ip ?? 'unknown';
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < Date.now()) attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else entry.count++;
}

function clearFailures(req: Request): void {
  attempts.delete(req.ip ?? 'unknown');
}

/** Throws 403/429 unless `password` matches the current login (rate limited). */
export function requireCurrentPassword(req: Request, password: unknown): void {
  checkRate(req);
  if (!verifyCurrentPassword(password)) {
    recordFailure(req);
    throw new ApiError(403, 'Password is incorrect.');
  }
  clearFailures(req);
}

export const authRouter = Router();

authRouter.get('/auth/status', (req, res) => {
  const source = authSource();
  const session = sessionFor(req);
  const status: AuthStatus = {
    authRequired: true,
    authenticated: Boolean(session) || hasValidApiKey(req),
    username: session?.username ?? null,
    source,
    setupRequired: source === 'none',
  };
  res.json(status);
});

/** First-run: create the one and only login. The middleware blocks this once a login exists. */
authRouter.post(
  '/auth/setup',
  ah(async (req, res) => {
    checkRate(req);
    if (authSource() !== 'none') throw new ApiError(403, 'Setup has already been completed.');
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const { user, pass } = validateNewCredentials(username, password);
    setSetting('auth_username', user);
    setSetting('auth_password_hash', hashPassword(pass));
    console.log('[auth] initial login created');
    setSessionCookie(req, res, user);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/auth/login',
  ah(async (req, res) => {
    checkRate(req);
    if (authSource() === 'none') throw new ApiError(409, 'No login exists yet. Create one first.');
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const ok = typeof username === 'string' && typeof password === 'string' && verifyCredentials(username.trim(), password);
    if (!ok) {
      recordFailure(req);
      throw new ApiError(401, 'Invalid username or password');
    }
    clearFailures(req);
    setSessionCookie(req, res, currentUsername());
    res.json({ ok: true });
  }),
);

authRouter.post('/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

/** Change the UI-managed login (requires the current password). */
authRouter.put(
  '/auth/credentials',
  ah(async (req, res) => {
    if (authSource() === 'env') {
      throw new ApiError(400, 'Login is managed by the AUTH_USERNAME / AUTH_PASSWORD environment variables.');
    }
    const { currentPassword, username, password } = (req.body ?? {}) as {
      currentPassword?: unknown;
      username?: unknown;
      password?: unknown;
    };
    checkRate(req);
    if (!verifyCurrentPassword(currentPassword)) {
      recordFailure(req);
      throw new ApiError(403, 'Current password is incorrect.');
    }
    const { user, pass } = validateNewCredentials(username, password);
    setSetting('auth_username', user);
    setSetting('auth_password_hash', hashPassword(pass));
    // Old sessions (other browsers) are invalidated; keep this one signed in.
    setSessionCookie(req, res, user);
    res.json({ ok: true });
  }),
);
